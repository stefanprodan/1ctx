// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export const FAIL_CONFIRM = `create trigger fail_draft_confirm
  before update on automation_drafts when new.state = 'confirmed'
  begin select raise(abort, 'confirm transaction failed'); end`;
