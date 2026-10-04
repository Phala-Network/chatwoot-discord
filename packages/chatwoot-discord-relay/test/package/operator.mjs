// Load the emitted runtime export from the installed tarball, not a source/declaration path.
import assert from "node:assert/strict";
import {
  auditPage,
  escalationBaseline,
  importAdoptionPage,
  inventory,
  keyPage,
  nextReceiptPosition,
  prepareAdoption,
  receiptPage,
  receiptSeal,
  sealAdoptionHistory,
  stageAdoption,
  validateCut,
  validateReceiptPage,
  verifyAdoptionLinks,
  verifyLinks,
} from "chatwoot-discord-relay/operator";

for (const method of [
  inventory,
  escalationBaseline,
  receiptPage,
  auditPage,
  keyPage,
  prepareAdoption,
  importAdoptionPage,
  sealAdoptionHistory,
  nextReceiptPosition,
  receiptSeal,
  validateReceiptPage,
  stageAdoption,
  validateCut,
  verifyAdoptionLinks,
  verifyLinks,
])
  assert.equal(typeof method, "function");
assert.throws(() => validateCut({}), /./);

const calls = [];
const page = { schemaVersion: 9, mappings: [], complete: true };
const actual = await inventory(
  {
    LEGACY_HUB: {
      getByName(name) {
        assert.equal(name, "global");
        return {
          async inventory(after) {
            calls.push(after);
            return page;
          },
        };
      },
    },
  },
  100,
);
assert.deepEqual(actual, page);
assert.deepEqual(calls, [100]);
