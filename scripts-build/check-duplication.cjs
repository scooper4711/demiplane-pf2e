#!/usr/bin/env node
/**
 * Check code duplication and fail if it exceeds acceptable thresholds.
 *
 * Thresholds (based on coding standards):
 * - 0-5%: Excellent
 * - 5-10%: Acceptable
 * - 10-20%: Needs attention (warning)
 * - >20%: Requires immediate refactoring (error)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const THRESHOLDS = { excellent: 5, acceptable: 10, warning: 20 };

try {
  console.log('Running code duplication analysis...\n');
  execSync('npx jscpd src/', { stdio: 'inherit' });

  const reportPath = path.join(__dirname, '../debug/jscpd-report/jscpd-report.json');
  if (!fs.existsSync(reportPath)) {
    console.error('Error: jscpd report not found');
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const statistics = report.statistics?.total;
  if (!statistics) {
    console.error('Error: Could not read statistics from report');
    process.exit(1);
  }

  const duplicationPercentage = statistics.percentage || 0;
  const duplicatedLines = statistics.duplicatedLines || 0;
  const totalLines = statistics.lines || 0;

  console.log('\n' + '='.repeat(60));
  console.log('CODE DUPLICATION REPORT');
  console.log('='.repeat(60));
  console.log(`Total Lines:       ${totalLines}`);
  console.log(`Duplicated Lines:  ${duplicatedLines}`);
  console.log(`Duplication:       ${duplicationPercentage.toFixed(2)}%`);
  console.log('='.repeat(60));

  let exitCode = 0;
  if (duplicationPercentage > THRESHOLDS.warning) {
    exitCode = 1;
    console.log(`\n❌ FAILED: Duplication (${duplicationPercentage.toFixed(2)}%) exceeds ${THRESHOLDS.warning}%`);
  } else if (duplicationPercentage > THRESHOLDS.acceptable) {
    console.log(`\n⚠️  WARNING: Duplication (${duplicationPercentage.toFixed(2)}%) exceeds ${THRESHOLDS.acceptable}%`);
  } else if (duplicationPercentage > THRESHOLDS.excellent) {
    console.log(`\n✓ ACCEPTABLE: Duplication (${duplicationPercentage.toFixed(2)}%) is within range.`);
  } else {
    console.log(`\n✓ EXCELLENT: Duplication (${duplicationPercentage.toFixed(2)}%) is minimal.`);
  }

  process.exit(exitCode);
} catch (error) {
  console.error('Error running duplication check:', error.message);
  process.exit(1);
}
