// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import type { Migration } from "../migration.ts";

// The models.dev id an agent's cost is computed by, set at save from
// the catalog row: an Azure deployment's id is not one. An agent saved
// before it takes its model id where its wire has a models.dev
// provider, on Azure the deployed model its name holds as `id (model)`;
// an id models.dev lacks prices nothing, as no id would.
export const m0048: Migration = {
  id: "0048-agent-listed-as",
  up(db) {
    db.exec(`
      alter table agents add column listed_as text;
      update agents set listed_as = model
        where provider_id in (
          select id from providers where wire in ('gemini', 'opencode')
        );
      update agents set listed_as =
          case when model_name like model || ' (%)'
            then substr(model_name, length(model) + 3,
              length(model_name) - length(model) - 3)
            else model end
        where provider_id in (select id from providers where wire = 'azure');
    `);
  },
};
