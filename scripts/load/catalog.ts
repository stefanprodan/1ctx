// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The three fake MCP servers and their 93 tools: the fake MCP serves
// them, the database builder registers them, the fake model calls them.

export type McpServer = { name: string; instructions: string; tools: string[] };

export const SERVERS: Record<string, McpServer> = {
  cluster: {
    name: "cluster",
    instructions:
      "Inspects the Kubernetes clusters and the Flux pipelines. Read resources with get_kubernetes_resources, logs with get_kubernetes_logs, and trace an object to its source with trace_kubernetes_resource.",
    tools: [
      "get_flux_instance",
      "get_kubernetes_api_versions",
      "get_kubernetes_contexts",
      "set_kubernetes_context",
      "get_kubernetes_resources",
      "get_kubernetes_logs",
      "get_kubernetes_events",
      "get_kubernetes_metrics",
      "trace_kubernetes_resource",
      "search_flux_docs",
      "reconcile_flux_kustomization",
      "reconcile_flux_helmrelease",
      "reconcile_flux_source",
      "suspend_flux_reconciliation",
      "resume_flux_reconciliation",
      "apply_kubernetes_manifest",
      "delete_kubernetes_resource",
    ],
  },
  git: {
    name: "git",
    instructions:
      "Reads and changes the team's repositories: files, commits, releases, pull requests, issues and workflow runs.",
    tools: [
      "get_file_contents",
      "search_code",
      "list_commits",
      "get_commit",
      "get_latest_release",
      "list_releases",
      "get_release_by_tag",
      "list_tags",
      "list_branches",
      "search_pull_requests",
      "get_pull_request",
      "get_pull_request_diff",
      "get_pull_request_files",
      "get_pull_request_reviews",
      "get_pull_request_comments",
      "get_pull_request_status",
      "list_pull_requests",
      "create_pull_request",
      "update_pull_request",
      "merge_pull_request",
      "create_pull_request_review",
      "add_pull_request_comment",
      "search_issues",
      "get_issue",
      "list_issues",
      "create_issue",
      "update_issue",
      "add_issue_comment",
      "get_issue_comments",
      "search_repositories",
      "get_repository",
      "list_workflows",
      "list_workflow_runs",
      "get_workflow_run",
      "get_workflow_run_logs",
      "list_workflow_jobs",
      "get_job_logs",
      "rerun_workflow_run",
      "list_code_scanning_alerts",
      "get_code_scanning_alert",
      "list_dependabot_alerts",
      "list_secret_scanning_alerts",
      "create_branch",
      "create_or_update_file",
      "push_files",
      "fork_repository",
      "list_notifications",
      "get_me",
    ],
  },
  docs: {
    name: "docs",
    instructions:
      "Searches the product documentation, API and CLI references, CRD schemas and the changelog.",
    tools: [
      "search_docs",
      "read_doc",
      "list_docs",
      "get_doc_outline",
      "get_doc_section",
      "search_api_reference",
      "get_api_reference",
      "list_guides",
      "get_guide",
      "search_changelog",
      "get_changelog",
      "list_versions",
      "get_version_notes",
      "search_examples",
      "get_example",
      "list_crds",
      "get_crd_schema",
      "search_crd_fields",
      "get_cli_reference",
      "search_cli_flags",
      "list_tutorials",
      "get_tutorial",
      "search_faq",
      "get_faq",
      "list_glossary",
      "get_glossary_term",
      "search_blog",
      "get_blog_post",
    ],
  },
};

export const SERVER_NAMES = Object.keys(SERVERS);

const EXTRA: Record<string, Record<string, unknown>> = {
  cluster: {
    namespace: {
      type: "string",
      description: "The namespace, all when empty.",
    },
    kind: {
      type: "string",
      description: "The resource kind, e.g. HelmRelease.",
    },
  },
  git: {
    repo: { type: "string", description: "owner/name of the repository." },
    ref: { type: "string", description: "A branch, tag or commit." },
  },
  docs: {},
};

export const words = (tool: string) => tool.replaceAll("_", " ");

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export function toolDef(server: string, tool: string): ToolDef {
  const text = words(tool);
  return {
    name: tool,
    description: `${text[0]!.toUpperCase()}${text.slice(1)} on the ${server} server. The query narrows the result.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
        size: {
          type: "string",
          enum: ["small", "large"],
          description: "large returns everything.",
        },
        ...EXTRA[server],
      },
      required: ["query"],
    },
  };
}
