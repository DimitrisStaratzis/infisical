import { Knex } from "knex";

import { PamAccountType } from "@app/ee/services/pam/pam-enums";
import { PamRecordingStorageBackend } from "@app/ee/services/pam-session-recording/pam-recording-enums";

import { ProjectType, TableName } from "../schemas";

// DEFAULT_ACCOUNT_TEMPLATES only runs when a PAM project is bootstrapped, so projects created
// before this type existed never receive its template — and pam_accounts.templateId is NOT NULL,
// so without one the type is unusable. Backfill one row per existing PAM project.
const TEMPLATE_NAME = "nirvana-dashboard";
const TEMPLATE_INSERT_CHUNK = 1000;

const TEMPLATE_SETTINGS = {
  recordingEnabled: true,
  recordingStorageBackend: PamRecordingStorageBackend.Postgres
};

export async function up(knex: Knex): Promise<void> {
  const pamProjects = await knex(TableName.Project).where({ type: ProjectType.PAM }).select("id");

  if (!pamProjects.length) return;

  const rows = pamProjects.map(({ id }) => ({
    projectId: id,
    name: TEMPLATE_NAME,
    type: PamAccountType.NirvanaDashboard,
    settings: TEMPLATE_SETTINGS
  }));

  for (let i = 0; i < rows.length; i += TEMPLATE_INSERT_CHUNK) {
    // Chunked and conflict-ignoring so a re-run is a no-op and a large fleet does not hold write
    // locks on pam_account_templates for one statement per project.
    // eslint-disable-next-line no-await-in-loop
    await knex(TableName.PamAccountTemplate)
      .insert(rows.slice(i, i + TEMPLATE_INSERT_CHUNK))
      .onConflict(["projectId", "name"])
      .ignore();
  }
}

export async function down(knex: Knex): Promise<void> {
  // Only remove templates that are still unused. A template with accounts attached is load-bearing
  // (pam_accounts.templateId is NOT NULL), so deleting it would either fail on the FK or orphan
  // real accounts — rolling back the code must not destroy an operator's data.
  const inUse = knex(TableName.PamAccount).select("templateId").whereNotNull("templateId");

  await knex(TableName.PamAccountTemplate)
    .where({ name: TEMPLATE_NAME, type: PamAccountType.NirvanaDashboard })
    .whereNotIn("id", inUse)
    .delete();
}
