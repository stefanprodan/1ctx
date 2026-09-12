// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The :name segments of a matched route, as a view receives them. Its
// own module, with no imports, so a view can name the type without
// reaching the route table that lazily imports the view.

export type Params = Record<string, string>;
