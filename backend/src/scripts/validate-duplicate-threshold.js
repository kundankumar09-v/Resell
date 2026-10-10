#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Standalone validation script for the perceptual-hash duplicate-detection
 * threshold (HASH_SIMILARITY_THRESHOLD).
 *
 * Usage:
 *   1. First run:  node src/utils/seed.js --with-duplicate-fixtures
 *   2. Then run:   node src/scripts/validate-duplicate-threshold.js
 *
 * Reads duplicate-fixture-report.json, runs every pairwise comparison
 * within each group using the actual hammingDistance() function,
 * and outputs a summary table.
 */

const fs = require('fs');
const path = require('path');
const { hammingDistance } = require('../services/imageHash');

const THRESHOLD = Number(process.env.HASH_SIMILARITY_THRESHOLD) || 12;

function loadReport() {
  const reportPath = path.join(__dirname, '../../duplicate-fixture-report.json');
  if (!fs.existsSync(reportPath)) {
    console.error(`Report not found at ${reportPath}`);
    console.error('Run: node src/utils/seed.js --with-duplicate-fixtures');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
}

function pairwiseComparisons(items, groupLabel) {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const distance = hammingDistance(a.hash, b.hash);
      const flagged = distance <= THRESHOLD;
      const pairLabel = `${a.id || a.originalId || '?'} ↔ ${b.id || b.originalId || '?'}`;
      results.push({ pair: pairLabel, group: groupLabel, distance, flagged });
    }
  }
  return results;
}

function crossGroupComparisons(originals, variants, similarPairs) {
  const results = [];

  // Compare each variant against its own original (should be flagged)
  for (const v of variants) {
    const orig = originals.find((o) => o.id === v.originalId);
    if (!orig) continue;
    const distance = hammingDistance(orig.hash, v.hash);
    const flagged = distance <= THRESHOLD;
    const pairLabel = `${orig.id} (orig) ↔ ${v.originalId}/${v.variantType}`;
    results.push({ pair: pairLabel, group: 'original-vs-variant', distance, flagged });
  }

  // Compare similar pairs against each other (should NOT be flagged)
  for (let i = 0; i < similarPairs.length; i++) {
    for (let j = i + 1; j < similarPairs.length; j++) {
      if (similarPairs[i].pairGroup === similarPairs[j].pairGroup) {
        const distance = hammingDistance(similarPairs[i].hash, similarPairs[j].hash);
        const flagged = distance <= THRESHOLD;
        const pairLabel = `${similarPairs[i].id} ↔ ${similarPairs[j].id}`;
        results.push({ pair: pairLabel, group: 'similar-pair-internal', distance, flagged });
      }
    }
  }

  // Cross-category: compare each variant against all similar-but-different (should NOT be flagged)
  for (const v of variants) {
    for (const s of similarPairs) {
      const distance = hammingDistance(v.hash, s.hash);
      const flagged = distance <= THRESHOLD;
      const pairLabel = `${v.originalId}/${v.variantType} ↔ ${s.id}`;
      results.push({ pair: pairLabel, group: 'variant-vs-similar', distance, flagged });
    }
  }

  return results;
}

function printTable(rows) {
  const header = 'Pair'.padEnd(60) + 'Group'.padEnd(28) + 'Dist'.padStart(5) + '  ' + 'Flag'.padStart(4) + '  ' + 'Correct?'.padStart(8);
  console.log(header);
  console.log('-'.repeat(header.length));

  let tp = 0, fp = 0, tn = 0, fn = 0;

  for (const r of rows) {
    let correct;
    if (r.group.includes('variant') || r.group.includes('original-vs')) {
      // These ARE duplicates — flagged = correct (TP), not flagged = wrong (FN)
      correct = r.flagged;
      if (r.flagged) tp++; else fn++;
    } else {
      // These are NOT duplicates — not flagged = correct (TN), flagged = wrong (FP)
      correct = !r.flagged;
      if (!r.flagged) tn++; else fp++;
    }

    const flagStr = r.flagged ? '  Y' : '  N';
    const correctStr = correct ? '  Y' : '  N';
    console.log(`${r.pair.padEnd(60)}${r.group.padEnd(28)}${String(r.distance).padStart(5)}${flagStr}  ${correctStr}`);
  }

  return { tp, fp, tn, fn };
}

function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  Perceptual Hash Threshold Validation — 64-bit DCT pHash');
  console.log(`  HASH_SIMILARITY_THRESHOLD = ${THRESHOLD}`);
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const report = loadReport();
  const { originals, trueDuplicates, similarButDifferent } = report.groups;

  console.log(`Loaded ${originals.length} originals, ${trueDuplicates.length} true-duplicate variants, ${similarButDifferent.length} similar-but-different images\n`);

  // Print hash table
  console.log('── Hash Table ────────────────────────────────────────────────────────');
  for (const img of originals) {
    console.log(`  [ORIG]  ${img.id.padEnd(14)} ${img.hash}  (${img.category})`);
  }
  for (const v of trueDuplicates) {
    console.log(`  [VARIANT] ${v.originalId}/${v.variantType.padEnd(28)} ${v.hash}  (${v.category})`);
  }
  for (const s of similarButDifferent) {
    console.log(`  [SIMILAR] ${s.id.padEnd(14)} ${s.hash}  (${s.category}, pair=${s.pairGroup})`);
  }
  console.log('');

  // ── Intra-group comparisons ──────────────────────────────────────────

  // 1. Variant vs its own original (true-duplicate pairs)
  console.log('── Group 1: Original ↔ Its Own Variants (expect: flagged) ──────────');
  const origVsVariant = [];
  for (const v of trueDuplicates) {
    const orig = originals.find((o) => o.id === v.originalId);
    if (!orig) continue;
    const distance = hammingDistance(orig.hash, v.hash);
    const flagged = distance <= THRESHOLD;
    origVsVariant.push({ pair: `${orig.id} ↔ ${v.originalId}/${v.variantType}`, group: 'original-vs-variant', distance, flagged });
  }
  const g1 = printTable(origVsVariant);
  console.log('');

  // 2. Similar pair internal (same-category different products)
  console.log('── Group 2: Similar Pair Internals (expect: NOT flagged) ────────────');
  const similarInternal = [];
  const pairGroups = [...new Set(similarButDifferent.map((s) => s.pairGroup))];
  for (const pg of pairGroups) {
    const pair = similarButDifferent.filter((s) => s.pairGroup === pg);
    if (pair.length === 2) {
      const distance = hammingDistance(pair[0].hash, pair[1].hash);
      const flagged = distance <= THRESHOLD;
      similarInternal.push({ pair: `${pair[0].id} ↔ ${pair[1].id}`, group: 'similar-pair-internal', distance, flagged });
    }
  }
  const g2 = printTable(similarInternal);
  console.log('');

  // 3. Variant vs all similar-but-different (cross-group)
  console.log('── Group 3: Variant ↔ Similar-But-Different (expect: NOT flagged) ──');
  const crossGroup = [];
  for (const v of trueDuplicates) {
    for (const s of similarButDifferent) {
      const distance = hammingDistance(v.hash, s.hash);
      const flagged = distance <= THRESHOLD;
      crossGroup.push({ pair: `${v.originalId}/${v.variantType} ↔ ${s.id}`, group: 'variant-vs-similar', distance, flagged });
    }
  }
  const g3 = printTable(crossGroup);
  console.log('');

  // ── Aggregate ────────────────────────────────────────────────────────
  const tp = g1.tp + g3.tp;
  const fp = g2.fp + g3.fp;
  const tn = g2.tn + g3.tn;
  const fn = g1.fn + g3.fn;
  const totalPairs = tp + fp + tn + fn;
  const totalPositive = tp + fn;
  const totalNegative = tn + fp;

  const tpRate = totalPositive > 0 ? (tp / totalPositive * 100).toFixed(1) : 'N/A';
  const fpRate = totalNegative > 0 ? (fp / totalNegative * 100).toFixed(1) : 'N/A';
  const accuracy = (tp + tn) / totalPairs * 100;

  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  AGGREGATE RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  Metric                                    Value');
  console.log('  ───────────────────────────────────────── ──────');
  console.log(`  Total pairs tested                        ${totalPairs}`);
  console.log(`  True Positives  (flagged duplicates)      ${tp}`);
  console.log(`  False Positives (flagged non-duplicates)  ${fp}`);
  console.log(`  True Negatives  (correctly unflagged)     ${tn}`);
  console.log(`  False Negatives (missed real duplicates)  ${fn}`);
  console.log('  ───────────────────────────────────────── ──────');
  console.log(`  True-Positive Rate  (TP / actual +)       ${tpRate}% (${tp}/${totalPositive})`);
  console.log(`  False-Positive Rate (FP / actual −)       ${fpRate}% (${fp}/${totalNegative})`);
  console.log(`  Overall Accuracy   ((TP+TN) / total)      ${accuracy.toFixed(1)}%`);
  console.log('');

  // ── Verdict ──────────────────────────────────────────────────────────
  if (fp === 0) {
    console.log(`  VERDICT: Threshold of ${THRESHOLD} on 64-bit DCT pHash produces ZERO false positives.`);
    console.log('  The system correctly distinguishes genuinely different images from duplicates.');
  } else {
    console.log(`  VERDICT: ${fp} false positive(s) detected at threshold ${THRESHOLD}.`);
    console.log('');
    console.log('  RECOMMENDED NEXT STEPS:');
    console.log('  1. Raise HASH_SIMILARITY_THRESHOLD to reduce false positives.');
    console.log(`     Current threshold: ${THRESHOLD} → Consider: ${THRESHOLD + 2} or ${THRESHOLD + 4}`);
    console.log('  2. The 64-bit DCT pHash already provides strong discrimination.');
    console.log('     If FP rate is high, consider adding a secondary verification step');
    console.log('     (e.g., image histogram comparison or SSIM) for borderline cases');
    console.log('     where distance is within 2 points of the threshold.');
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════');
}

main();
