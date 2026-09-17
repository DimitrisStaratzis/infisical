import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildUpgradeReturnPath,
  DynamicSecretsUpgradeIntent,
  getSafeUpgradeReturnPath
} from "./upgrade-intents";

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

describe("getSafeUpgradeReturnPath", () => {
  it("accepts same-origin relative paths", () => {
    assert.equal(
      getSafeUpgradeReturnPath(
        "/organizations/org-1/projects?checkout=success",
        "https://app.infisical.com"
      ),
      "/organizations/org-1/projects?checkout=success"
    );
  });

  it("rejects paths that normalize to an external origin", () => {
    assert.equal(getSafeUpgradeReturnPath("/\t/evil.example", "https://app.infisical.com"), null);
    assert.equal(getSafeUpgradeReturnPath("/\\evil.example", "https://app.infisical.com"), null);
  });
});
