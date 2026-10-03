// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// An MCP call's arguments checked against the tool's stored schema.

import type { JsonSchemaType } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { isRecord } from "../../shared/words.ts";

type Validate = (input: unknown) => { valid: boolean; errorMessage?: string };

// Ajv keeps every schema object it compiled, for good, and each send
// parses its offer's schemas afresh, so validators are kept by the
// schema's text, and a full cache drops the engine with them
export const MAX_VALIDATORS = 256;
let argumentValidator = new AjvJsonSchemaValidator();
const validators = new Map<string, Validate | null>();

// null when the schema does not compile or the check throws
function check(
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): ReturnType<Validate> | null {
  const text = JSON.stringify(schema);
  if (!validators.has(text)) {
    if (validators.size >= MAX_VALIDATORS) {
      validators.clear();
      argumentValidator = new AjvJsonSchemaValidator();
    }
    let validate: Validate | null = null;
    try {
      validate = argumentValidator.getValidator(schema as JsonSchemaType);
    } catch {}
    validators.set(text, validate);
  }
  try {
    return validators.get(text)?.(input) ?? null;
  } catch {
    return null;
  }
}

// Ajv's own text names neither an unknown nor a missing property, so
// the top level is checked first; a schema Ajv cannot compile lets the
// call through for the server to judge
export function validateArguments(
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): string | null {
  const result = check(schema, input);
  if (result === null || result.valid) return null;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name) => typeof name === "string")
    : [];
  const unknown =
    schema.additionalProperties === false
      ? Object.keys(input).filter((name) => !Object.hasOwn(properties, name))
      : [];
  const missing = required.filter((name) => !Object.hasOwn(input, name));
  const others = (result.errorMessage ?? "")
    .split(/, (?=data\b)/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" &&
        !(
          unknown.length > 0 &&
          line === "data must NOT have additional properties"
        ) &&
        !(
          missing.length > 0 &&
          line.startsWith("data must have required property")
        ),
    )
    .map((line) => line.replace(/^data\b/, "arguments"));
  const problems = [
    ...unknown.map((name) => `unknown property '${name}'`),
    ...missing.map((name) => `missing required property '${name}'`),
    ...others,
  ];
  if (problems.length === 0) problems.push("arguments are invalid");
  const names = Object.keys(properties).map((name) =>
    required.includes(name) ? `${name} (required)` : name,
  );
  const list =
    names.length > MAX_LISTED
      ? `${names.slice(0, MAX_LISTED).join(", ")} and ${names.length - MAX_LISTED} more`
      : names.join(", ");
  return `${problems.join("; ")}. ${
    names.length === 0 ? "It takes no parameters." : `Its parameters: ${list}.`
  }`;
}

const MAX_LISTED = 40;
