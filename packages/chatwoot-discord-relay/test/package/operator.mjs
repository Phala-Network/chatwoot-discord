// Verify installed tarball runtime exports and the bounded private source contract.
import assert from "node:assert/strict";
import {
  assertVerifiedCut,
  escalationBaseline,
  importAdoptionPage,
  LegacyArchive,
  legacyScanPage,
  nextReceiptPosition,
  prepareAdoption,
  receiptSeal,
  scanPage,
  sealAdoptionHistory,
  stageAdoption,
  validateCut,
  validateReceiptPage,
  verifyAdoptionLinks,
  verifyLinkBatch,
} from "chatwoot-discord-relay/operator";

for (const method of [
  LegacyArchive,
  scanPage,
  legacyScanPage,
  escalationBaseline,
  prepareAdoption,
  importAdoptionPage,
  sealAdoptionHistory,
  nextReceiptPosition,
  receiptSeal,
  validateReceiptPage,
  stageAdoption,
  validateCut,
  verifyAdoptionLinks,
  verifyLinkBatch,
  assertVerifiedCut,
])
  assert.equal(typeof method, "function");
assert.throws(() => validateCut({}), /./);
const calls = [];
const source = { sourceIdentity: "actual-source-id", epoch: "cut", drainEvidence: "private:settled", frozen: true };
const page = { schemaVersion: 9, rows: [], complete: true };
const actual = await scanPage(
  {
    LEGACY_HUB: {
      getByName(name) {
        assert.equal(name, "global");
        return {
          async scanPage(boundary, after) {
            calls.push([boundary, after]);
            return page;
          },
        };
      },
    },
  },
  source,
  { kind: 0, rowid: 100 },
);
assert.deepEqual(actual, page);
assert.deepEqual(calls, [[source, { kind: 0, rowid: 100 }]]);
