#!/usr/bin/env node

const isNode = typeof process !== 'undefined' && process.release && process.release.name === 'node';

let fs;
let path;
let vm;

if (isNode) {
  fs = require('fs');
  path = require('path');
  vm = require('vm');
}

let environmentBootstrapped = false;

function loadScript(relativePath) {
  if (!isNode) {
    throw new Error('loadScript can only be used in a Node environment.');
  }
  const absolutePath = path.resolve(__dirname, '..', relativePath);
  let code = fs.readFileSync(absolutePath, 'utf8');
  if (code.charCodeAt(0) === 0xfeff) {
    code = code.slice(1);
  }
  vm.runInThisContext(code, { filename: absolutePath });
}

function bootstrapSimulationEnvironment() {
  if (environmentBootstrapped) {
    return;
  }

  if (isNode) {
    global.window = global.window || { location: { search: '', href: '' } };
    global.SIMULATOR = global.SIMULATOR || { battlegrounds: { onCreate: [], onTurn: [], onCardPlayed: [] } };

    const dataScripts = [
      'scripts/data/skills.js',
      'scripts/data/cards.js',
      'scripts/data/fusions.js',
      'scripts/data/spoilers.js',
      'scripts/data/bges.js',
      'scripts/data/mapBGEs.js',
      'scripts/data/campaign.js',
      'scripts/data/runes.js',
      'scripts/data/raids.js',
      'scripts/data/common.js'
    ];

    dataScripts.forEach(loadScript);
    loadScript('scripts/data/fixGlobals.js');

    loadScript('scripts/shared.js');
    loadScript('scripts/simulator_base.js');

    if (!SIMULATOR.battlegrounds) {
      SIMULATOR.battlegrounds = { onCreate: [], onTurn: [], onCardPlayed: [] };
    }
  } else {
    if (typeof SIMULATOR === 'undefined') {
      throw new Error('Simulator environment is not available. Make sure simulator scripts are loaded.');
    }
    if (!SIMULATOR.battlegrounds) {
      SIMULATOR.battlegrounds = { onCreate: [], onTurn: [], onCardPlayed: [] };
    }
  }

  environmentBootstrapped = true;
}

function parseArguments() {
  if (!isNode) {
    throw new Error('parseArguments can only be used in a Node environment.');
  }
  const [, , deckHash, simsArg] = process.argv;
  if (!deckHash) {
    console.error('Usage: node optimisation/deck_card_analysis.js <deckHash> [simulationsPerDuel]');
    process.exit(1);
  }
  const simulations = simsArg ? Number(simsArg) : 100;
  if (!Number.isFinite(simulations) || simulations <= 0) {
    console.error('The number of simulations must be a positive number.');
    process.exit(1);
  }
  return { deckHash, simulations: Math.floor(simulations) };
}

function createSimConfig(playerDeckHash, cpuDeckHash, simulations) {
  return {
    enemybges: '',
    getbattleground: '',
    selfbges: '',
    mapbges: '',
    playerDeck: playerDeckHash,
    playerOrdered: false,
    playerExactOrdered: false,
    cpuDeck: cpuDeckHash,
    cpuOrdered: false,
    cpuExactOrdered: false,
    surge: false,
    siegeMode: false,
    towerType: '',
    towerLevel: '1',
    campaignID: '',
    missionID: '',
    missionLevel: 1,
    raidID: '',
    raidLevel: 1,
    showAnimations: false,
    simsToRun: simulations,
    tournament: false,
    debug: false,
    logPlaysOnly: false,
    massDebug: false,
    findFirstWin: false,
    findFirstLoss: false
  };
}

function simulateMatchup(playerDeckHash, cpuDeckHash, simulations) {
  const config = createSimConfig(playerDeckHash, cpuDeckHash, simulations);
  SIMULATOR.userControlled = false;
  SIMULATOR.config = config;
  SIMULATOR.battlegrounds = getBattlegrounds(config);
  SIMULATOR.setupDecks();

  let playerWins = 0;
  let cpuWins = 0;
  let draws = 0;

  for (let i = 0; i < simulations; i++) {
    SIMULATOR.simulate();
    const playerAlive = SIMULATOR.field.player.commander.isAlive();
    const cpuAlive = SIMULATOR.field.cpu.commander.isAlive();
    if (playerAlive && !cpuAlive) {
      playerWins += 1;
    } else if (!playerAlive && cpuAlive) {
      cpuWins += 1;
    } else {
      draws += 1;
    }
  }

  const total = playerWins + cpuWins + draws;
  return {
    playerWins,
    cpuWins,
    draws,
    total,
    playerWinrate: total ? playerWins / total : 0,
    cpuWinrate: total ? cpuWins / total : 0,
    drawRate: total ? draws / total : 0
  };
}

function cloneUnitInfo(unitInfo) {
  if (!unitInfo) {
    return unitInfo;
  }
  const clone = Object.assign({}, unitInfo);
  if (Array.isArray(unitInfo.runes)) {
    clone.runes = unitInfo.runes.slice();
  }
  if (Array.isArray(unitInfo.subskills)) {
    clone.subskills = unitInfo.subskills.slice();
  }
  return clone;
}

function cloneDeckDefinition(deck) {
  if (!deck) {
    return { commander: undefined, deck: [] };
  }
  return {
    commander: deck.commander ? cloneUnitInfo(deck.commander) : undefined,
    deck: Array.isArray(deck.deck) ? deck.deck.map(cloneUnitInfo) : []
  };
}

function describeCard(unitInfo) {
  if (!unitInfo) {
    return 'Unknown card';
  }
  const card = getCardByID(unitInfo);
  if (!card) {
    return 'Unknown card';
  }
  const runeSuffix = card.runes && card.runes.length ? '*' : '';
  const levelInfo = card.maxLevel > 1 ? ` {${card.level}/${card.maxLevel}}` : '';
  return `${card.name}${runeSuffix}${levelInfo}`;
}

function formatCardLabel(unitInfo, occurrenceTracker) {
  const baseLabel = describeCard(unitInfo);
  const count = (occurrenceTracker[baseLabel] || 0) + 1;
  occurrenceTracker[baseLabel] = count;
  return `${baseLabel} #${count}`;
}

function analyzeDeck(deckHash, simulations) {
  const decodedDeck = hash_decode(deckHash);
  if (!decodedDeck || !decodedDeck.deck || !decodedDeck.deck.length) {
    const message = 'The provided deck hash does not contain any cards.';
    if (isNode) {
      console.error(message);
      process.exit(1);
    }
    throw new Error(message);
  }

  const results = [];
  const occurrenceTracker = {};

  decodedDeck.deck.forEach((unitInfo, index) => {
    const trimmedDeck = {
      commander: decodedDeck.commander,
      deck: decodedDeck.deck.filter((_, idx) => idx !== index)
    };
    const trimmedHash = hash_encode(trimmedDeck);
    const { playerWins, cpuWins, draws, total, playerWinrate, cpuWinrate, drawRate } = simulateMatchup(deckHash, trimmedHash, simulations);
    const impact = playerWinrate - cpuWinrate;
    const label = formatCardLabel(unitInfo, occurrenceTracker);
    results.push({
      label,
      trimmedHash,
      cardIndex: index,
      unitInfo: cloneUnitInfo(unitInfo),
      stats: {
        simulations: total,
        playerWins,
        cpuWins,
        draws,
        playerWinrate,
        cpuWinrate,
        drawRate,
        impact
      }
    });
  });

  results.sort((a, b) => a.stats.cpuWinrate - b.stats.cpuWinrate || b.stats.impact - a.stats.impact);
  return results;
}

function printResults(deckHash, simulations, results) {
  console.log(`Deck hash: ${deckHash}`);
  console.log(`Simulations per duel: ${simulations}`);
  console.log('');
  console.log('Card Impact (sorted by winrate of deck without the card):');
  console.log('------------------------------------------------------------------------------------------');
  console.log('Card                               | Without Win% | With Win% | Draw% | Impact | Wins (Without/With/Draws)');
  console.log('------------------------------------------------------------------------------------------');
  results.forEach(({ label, stats, trimmedHash }) => {
    const withoutPct = (stats.cpuWinrate * 100).toFixed(2).padStart(12);
    const withPct = (stats.playerWinrate * 100).toFixed(2).padStart(10);
    const drawPct = (stats.drawRate * 100).toFixed(2).padStart(7);
    const impactPct = (stats.impact * 100).toFixed(2).padStart(7);
    const name = label.padEnd(33);
    console.log(`${name} | ${withoutPct} | ${withPct} | ${drawPct} | ${impactPct} | ${String(stats.cpuWins).padStart(5)}/${String(stats.playerWins).padStart(5)}/${String(stats.draws).padStart(5)} (trimmed: ${trimmedHash})`);
  });
}

function runDeckCardAnalysis(deckHash, simulations) {
  bootstrapSimulationEnvironment();

  if (!deckHash) {
    throw new Error('A deck hash is required to analyse cards.');
  }

  const desiredSimulations = simulations === undefined ? 100 : Number(simulations);
  if (!Number.isFinite(desiredSimulations) || desiredSimulations <= 0) {
    throw new Error('Simulations per duel must be a positive number.');
  }

  const normalizedSimulations = Math.floor(desiredSimulations);
  const results = analyzeDeck(deckHash, normalizedSimulations);
  return { deckHash, simulations: normalizedSimulations, results };
}

function optimizeDeck(deckHash, replacementsHash, simulations) {
  bootstrapSimulationEnvironment();

  if (!deckHash) {
    throw new Error('A deck hash is required to optimize a deck.');
  }

  const desiredSimulations = simulations === undefined ? 100 : Number(simulations);
  if (!Number.isFinite(desiredSimulations) || desiredSimulations <= 0) {
    throw new Error('Simulations per duel must be a positive number.');
  }

  const normalizedSimulations = Math.floor(desiredSimulations);

  const decodedDeck = hash_decode(deckHash);
  if (!decodedDeck || !decodedDeck.deck || !decodedDeck.deck.length) {
    throw new Error('The provided deck hash does not contain any cards to optimise.');
  }

  if (!replacementsHash) {
    throw new Error('A replacement deck hash is required to optimise the deck.');
  }

  const decodedReplacements = hash_decode(replacementsHash);
  const replacementCards = decodedReplacements && Array.isArray(decodedReplacements.deck)
    ? decodedReplacements.deck.map(cloneUnitInfo)
    : [];

  if (!replacementCards.length) {
    throw new Error('The replacement deck hash must contain at least one card.');
  }

  let currentDeck = cloneDeckDefinition(decodedDeck);
  let currentDeckHash = hash_encode(currentDeck);
  const steps = [];
  let iteration = 0;

  while (replacementCards.length) {
    iteration += 1;
    const nextCard = replacementCards.shift();
    const ranking = analyzeDeck(currentDeckHash, normalizedSimulations);

    if (!ranking.length) {
      break;
    }

    const worstCard = ranking[ranking.length - 1];
    const previousDeckHash = currentDeckHash;
    const removedIndex = worstCard.cardIndex;
    const removedCard = cloneUnitInfo(currentDeck.deck[removedIndex]);

    currentDeck.deck[removedIndex] = cloneUnitInfo(nextCard);
    const candidateDeckHash = hash_encode(currentDeck);
    const comparisonStats = simulateMatchup(candidateDeckHash, previousDeckHash, normalizedSimulations);
    const accepted = comparisonStats.playerWinrate > comparisonStats.cpuWinrate;

    if (!accepted) {
      currentDeck.deck[removedIndex] = removedCard;
    } else {
      currentDeckHash = candidateDeckHash;
    }

    steps.push({
      iteration,
      accepted,
      previousDeckHash,
      resultingDeckHash: accepted ? candidateDeckHash : previousDeckHash,
      removedCard: {
        index: removedIndex,
        label: worstCard.label,
        description: describeCard(removedCard)
      },
      addedCard: {
        description: describeCard(nextCard)
      },
      stats: comparisonStats
    });
  }

  return {
    initialDeckHash: deckHash,
    finalDeckHash: currentDeckHash,
    simulations: normalizedSimulations,
    steps
  };
}

function main() {
  const { deckHash, simulations } = parseArguments();
  const { results } = runDeckCardAnalysis(deckHash, simulations);
  printResults(deckHash, simulations, results);
}

const api = {
  run: runDeckCardAnalysis,
  optimizeDeck,
  analyzeDeck,
  simulateMatchup,
  createSimConfig,
  bootstrapSimulationEnvironment,
  printResults
};

if (isNode) {
  module.exports = api;
  if (require.main === module) {
    main();
  }
} else {
  window.DeckCardAnalysis = api;
}

