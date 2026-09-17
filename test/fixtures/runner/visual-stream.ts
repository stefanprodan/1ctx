// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

export const visualChunks = [
  {
    name: "split root key",
    chunks: ['{"ht', 'm', 'l":"<p>', 'Hello</p>"}'],
    html: ["", "", "<p>", "<p>Hello</p>"],
  },
  {
    name: "escaped key and split escapes",
    chunks: [
      '{"\\u00',
      '68t\\u006dl":"A\\',
      "u00",
      "e9\\",
      '"B\\',
      '\\C\\/',
      'D\\b\\f\\n\\r\\t"}',
    ],
    html: ["", "A", "A", "Aé", 'Aé"B', 'Aé"B\\C/', 'Aé"B\\C/D\b\f\n\r\t'],
  },
  {
    name: "escaped surrogate pair",
    chunks: ['{"html":"a\\uD83D', "\\u", "DE80", 'b"}'],
    html: ["a", "a", "a🚀", "a🚀b"],
  },
  {
    name: "raw surrogate pair",
    chunks: ['{"html":"a\uD83D', "\uDE80", '"}'],
    html: ["a", "a🚀", "a🚀"],
  },
  {
    name: "escaped high and raw low",
    chunks: ['{"html":"\\uD83D', '\uDE80"}'],
    html: ["", "🚀"],
  },
  {
    name: "raw high and escaped low",
    chunks: ['{"html":"\uD83D', "\\uDE", '80"}'],
    html: ["", "", "🚀"],
  },
  {
    name: "unpaired high at the closing quote",
    chunks: ['{"html":"a\\uD83D', '"', "}"],
    html: ["a", "a\uD83D", "a\uD83D"],
  },
  {
    name: "unpaired high before another character",
    chunks: ['{"html":"\\uD83D', 'x"}'],
    html: ["", "\uD83Dx"],
  },
  {
    name: "consecutive high surrogates",
    chunks: ['{"html":"\\uD83D', "\\uD83D", '\\uDE80"}'],
    html: ["", "\uD83D", "\uD83D🚀"],
  },
  {
    name: "unpaired low surrogate",
    chunks: ['{"html":"\\uDE80', '"}'],
    html: ["\uDE80", "\uDE80"],
  },
  {
    name: "unpaired high before an escaped quote",
    chunks: ['{"html":"\\uD83D', "\\", '"', '"}'],
    html: ["", "", '\uD83D"', '\uD83D"'],
  },
];

export const visualDocuments = [
  ...visualChunks.map(({ chunks }) => chunks.join("")),
  '{"html":"<p>first</p>","title":"Later"}',
  '{"title":"the \\"html\\" key: \\"html\\":\\"wrong\\"","html":"right"}',
  '{"other":{"html":"wrong","title":"wrong"},"html":"right","title":"Root"}',
  '{"other":[{"html":"wrong"},["html","wrong"]],"html":"right"}',
  '{"html":"right","other":{"html":"wrong"},"title":"Root"}',
  '{"html":"é東京🚀","other":[true,false,null,0,-0,42,-10.2,1e3,1E-3,1e+3]}',
  '{"other":[{},[],{"x":[]},-7.3E-12,1e400],"html":"right"}',
  ' \r\n\t { "html" : "right", "title" : "Root" } \n',
  '{"html":"","title":""}',
  '{"html":"right","\\u0074itle":"Escaped title"}',
  '{"html":"right","htmlx":"wrong","xhtml":"wrong"}',
  '{"html":"right","html\\u0000":"wrong","htm\\ud800l":"wrong"}',
];

export const nonObjectVisualDocuments = [
  "[]",
  '[{"html":"wrong"}]',
  '"html"',
  "null",
  "false",
  "0",
];

export const invalidVisualDocuments = [
  "not json",
  '{html:"wrong"}',
  "{'html':'wrong'}",
  '{"html" "wrong"}',
  '{"html":}',
  '{"html":,}',
  '{"html":"ok",}',
  '{"html":"ok",,"title":"wrong"}',
  '{"html":"ok" "title":"wrong"}',
  '{"html":"bad\\q"}',
  '{"html":"bad\\u00xz"}',
  '{"html":"raw\nnewline"}',
  '{"html":"raw\u0000nul"}',
  '{"html":"ok","other":[1,]}',
  '{"html":"ok","other":[,1]}',
  '{"html":"ok","other":[1 2]}',
  '{"html":"ok","other":{"x":true,}}',
  '{"html":"ok","other":{"x":"bad\\q"}}',
  '{"html":"ok","bad\\q":"ignored"}',
  '{"html":"ok","other":{"x":true]}',
  '{"html":"ok","other":[true}}',
  '{"html":"ok","other":True}',
  '{"html":"ok","other":truth}',
  '{"html":"ok","other":nul}',
  '{"html":"ok","other":falsex}',
  '{"html":"ok","other":01}',
  '{"html":"ok","other":-01}',
  '{"html":"ok","other":+1}',
  '{"html":"ok","other":.1}',
  '{"html":"ok","other":1.}',
  '{"html":"ok","other":1e}',
  '{"html":"ok","other":1e+}',
  '{"html":"ok","other":--1}',
  '{"html":"ok","other":NaN}',
  '{"html":"ok","other":Infinity}',
  '{"html":"ok","other":0x10}',
  '{"html":"ok"}{}',
  '{"html":"ok"}x',
  '\uFEFF{"html":"wrong"}',
  '{"html":"ok"\u00A0}',
];

export const duplicateVisualDocuments = [
  '{"html":"first","html":"second"}',
  '{"html":"first","\\u0068tml":"second"}',
  '{"\\u0068tml":"first","htm\\u006c":"second"}',
  '{"html":"first","html":{"html":"second"}}',
  '{"html":"first","html":null}',
];

export const incompleteVisualDocuments = [
  "",
  " \r\n\t",
  "{",
  '{"html"',
  '{"html":',
  '{"html":"',
  '{"html":"text\\',
  '{"html":"text\\u',
  '{"html":"text\\u00',
  '{"html":"text\\uD83D',
  '{"html":"text"',
  '{"html":"text",',
  '{"html":"text","other":[1',
  '{"html":"text","other":tru',
  '{"html":"text","other":1e+',
];
