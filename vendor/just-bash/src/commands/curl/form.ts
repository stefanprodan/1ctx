/**
 * Form data handling for curl command
 */

import type { FormField } from "./types.js";

// (1ctx curl-urlencode) curl writes its escapes in uppercase hex, %2A
export function encodeCurlData(value: string): string {
  return encodeURIComponent(value)
    .replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replace(/%20/g, "+");
}

/**
 * (1ctx curl-bytes) encodeCurlData over bytes: each one outside A-Z, a-z,
 * 0-9 and `-._~` as `%XX`, a space as `+`, so a byte that is not UTF-8 is
 * encoded as itself, as curl does.
 */
export function encodeCurlBytes(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(char)) encoded += char;
    else if (byte === 0x20) encoded += "+";
    // (1ctx curl-urlencode) in uppercase hex, as curl writes it
    else encoded += `%${byte.toString(16).padStart(2, "0").toUpperCase()}`;
  }
  return encoded;
}

/**
 * URL-encode form data in curl's --data-urlencode format
 * Supports: name=content, =content, content. The `@file` / `name@file` forms
 * are detected in parseOptions and deferred to execute time (see resolveData).
 */
export function encodeFormData(input: string): string {
  // Check for name=value format
  const eqIndex = input.indexOf("=");
  if (eqIndex >= 0) {
    const name = input.slice(0, eqIndex);
    const value = input.slice(eqIndex + 1);
    const encoded = encodeCurlData(value);
    return name ? `${name}=${encoded}` : encoded;
  }
  // Plain value
  return encodeCurlData(input);
}

/**
 * Parse -F/--form field specification
 * Supports: name=value, name=@file, name=<file, name=value;type=mime
 */
export function parseFormField(spec: string): FormField | null {
  const eqIndex = spec.indexOf("=");
  if (eqIndex < 0) return null;

  const name = spec.slice(0, eqIndex);
  let value = spec.slice(eqIndex + 1);
  let filename: string | undefined;
  let contentType: string | undefined;

  // Check for ;type= suffix
  const typeMatch = value.match(/;type=([^;]+)$/);
  if (typeMatch) {
    contentType = typeMatch[1];
    value = value.slice(0, -typeMatch[0].length);
  }

  // Check for ;filename= suffix
  const filenameMatch = value.match(/;filename=([^;]+)/);
  if (filenameMatch) {
    filename = filenameMatch[1];
    value = value.replace(filenameMatch[0], "");
  }

  // @ means file upload, < means file content
  if (value.startsWith("@") || value.startsWith("<")) {
    filename = filename ?? value.slice(1).split("/").pop();
    // Value will be replaced with file content in execute
  }

  return { name, value, filename, contentType };
}

/**
 * Generate multipart form data body and boundary
 */
export function generateMultipartBody(
  fields: FormField[],
  // (1ctx curl-bytes) a file's bytes make the body bytes
  fileContents: Map<string, string | Uint8Array>,
): { body: string | Uint8Array<ArrayBuffer>; boundary: string } {
  const boundary = `----CurlFormBoundary${Date.now().toString(36)}`;
  const parts: (string | Uint8Array)[] = [];

  for (const field of fields) {
    let value: string | Uint8Array = field.value;

    // Replace file references with content
    if (field.value.startsWith("@") || field.value.startsWith("<")) {
      const filePath = field.value.slice(1);
      value = fileContents.get(filePath) ?? "";
    }

    let part = `--${boundary}\r\n`;
    if (field.filename) {
      part += `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\n`;
      if (field.contentType) {
        part += `Content-Type: ${field.contentType}\r\n`;
      }
    } else {
      part += `Content-Disposition: form-data; name="${field.name}"\r\n`;
    }
    if (typeof value === "string") {
      part += `\r\n${value}\r\n`;
      parts.push(part);
    } else {
      parts.push(`${part}\r\n`, value, "\r\n");
    }
  }

  parts.push(`--${boundary}--\r\n`);
  if (parts.every((part) => typeof part === "string")) {
    return { body: parts.join(""), boundary };
  }
  // (1ctx curl-bytes) the text in UTF-8, the files as they are
  const encoder = new TextEncoder();
  const chunks = parts.map((part) =>
    typeof part === "string" ? encoder.encode(part) : part,
  );
  const body = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, boundary };
}
