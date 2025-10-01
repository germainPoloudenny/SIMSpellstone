#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadScript(relativePath) {
  const absolutePath = path.resolve(__dirname, '..', relativePath);
  let code = fs.readFileSync(absolutePath, 'utf8');
  if (code.charCodeAt(0) === 0xfeff) {
    code = code.slice(1);
  }
  vm.runInThisContext(code, { filename: absolutePath });
}

function bootstrapSimulationEnvironment() {
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
}

function parseArguments() {
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

function formatCardLabel(unitInfo, occurrenceTracker) {
  const card = getCardByID(unitInfo);
  const runeSuffix = card.runes && card.runes.length ? '*' : '';
  const levelInfo = card.maxLevel > 1 ? ` {${card.level}/${card.maxLevel}}` : '';
  const baseLabel = `${card.name}${runeSuffix}${levelInfo}`;
  const count = (occurrenceTracker[baseLabel] || 0) + 1;
  occurrenceTracker[baseLabel] = count;
  return `${baseLabel} #${count}`;
}

function analyzeDeck(deckHash, simulations) {
  const decodedDeck = hash_decode(deckHash);
  if (!decodedDeck || !decodedDeck.deck || !decodedDeck.deck.length) {
    console.error('The provided deck hash does not contain any cards.');
    process.exit(1);
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

(function main() {
  bootstrapSimulationEnvironment();
  const { deckHash, simulations } = parseArguments();
  const results = analyzeDeck(deckHash, simulations);
  printResults(deckHash, simulations, results);
})();

