import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildUpgradeReturnPath, DynamicSecretsUpgradeIntent } from "./upgrade-intents";

describe("buildUpgradeReturnPath", () => {
  it("preserves source state and adds the typed continuation", () => {
    const location = {
      pathname: "/organizations/org-1/projects/secret-management/project-1/overview",
      search: "?secretPath=%2Fproduction&environments=prod",
      hash: "#secrets"
    } as Location;

    assert.equal(
      buildUpgradeReturnPath(DynamicSecretsUpgradeIntent, location),
      "/organizations/org-1/projects/secret-management/project-1/overview?secretPath=%2Fproduction&environments=prod&upgradeContinuation=create-dynamic-secret#secrets"
    );
  });
});
