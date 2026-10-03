// Load the emitted runtime export from the installed tarball, not a source/declaration path.
import assert from "node:assert/strict";
import {
  inventory,
  stageAdoption,
  validateCut,
  verifyAdoptionLinks,
  verifyLinks,
} from "chatwoot-discord-relay/operator";

for (const method of [inventory, stageAdoption, validateCut, verifyAdoptionLinks, verifyLinks])
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
