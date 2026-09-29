// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// A command worker that throws as it loads, before any job.

throw new Error("the worker failed to load");
