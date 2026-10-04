// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// What the driver's users write: the automations' checks, the chats'
// questions and follow-ups, and the incident's messages in order.

export const CHECKS = [
  "check the ingress controllers for 5xx spikes since the last deploy and list the services above budget",
  "compare the HelmRelease revisions in production with the git source and report any drift",
  "list the pods that restarted in the last hour, with their last termination reason",
  "check certificate expiry across the clusters and flag anything due within 14 days",
  "summarise the open incidents and who owns each, from the runbooks folder",
  "review yesterday's failed reconciliations and say which ones still fail",
  "check the node pools for memory pressure and pods evicted overnight",
  "verify the backup jobs ran and their snapshots are under a day old",
  "scan the deploy pipeline for stuck rollouts and report their age",
  "check the quota usage per namespace and warn about the ones above 80%",
  "look for CrashLoopBackOff pods and match them to known runbooks",
  "report p95 latency per service against its SLO for the last 24 hours",
  "check the webhook receivers for delivery failures since midnight",
  "audit the image tags in production for anything not pinned to a digest",
  "list the dependency updates merged this week and the services they touch",
  "check DNS and ingress health for the public endpoints and note slow ones",
];
export const QUESTIONS = [
  "why does the payments rollout stall at 50% in the test cluster?",
  "how do I find which HelmRelease changed the ingress annotations yesterday?",
  "the checkout pods are OOMKilled after the last deploy, what changed?",
  "can you explain why the reconcile loop keeps reporting drift on the cache service?",
  "which runbook covers a certificate that failed to renew, and what are the steps?",
  "our p95 latency doubled on the search API since 10:00, where should I look?",
  "how do I roll back the orders service to the previous chart version safely?",
  "why does the webhook receiver return 403 for the git provider events?",
  "what is eating the quota in the analytics namespace?",
  "the canary for the auth service keeps failing its analysis, can you check why?",
  "help me write a jq filter for the events of the failing job",
  "which services still pin an old base image and need a rebuild?",
  "is the timeout on the inventory client too low given the last week of traces?",
  "summarise the incidents tagged crashloop from the last month",
  "how do I find the commit that changed the HPA limits for the gateway?",
  "the nightly backup job took twice as long, what changed in the cluster?",
];
export const FOLLOWUPS = [
  "thanks, can you dig into the logs around that time?",
  "what would the fix look like? show me the diff",
  "can you check whether the same thing happens in the other clusters?",
  "ok, and which runbook should I follow for that?",
  "could you write that up as a short summary for the team?",
  "is there anything in the recent incidents that looks related?",
  "can you verify that with the metrics instead of the events?",
  "what are the risks if we roll that out today?",
  "good, now list the services affected and their owners",
  "can you double check the timeline, I think the deploy was earlier",
];
export const INCIDENT = [
  "checkout is returning 502 for a third of requests since 09:12, all regions",
  "the error rate is still climbing, can you pull the gateway and ingress logs?",
  "I see OOMKilled on payments-api, correlate it with the deploy history",
  "rollback of payments-api is done, check whether the 502s are dropping",
  "the db connection pool looks saturated, check the pool metrics and recent config changes",
  "write the timeline so far into the incident notes",
  "draft the RCA: root cause, impact, detection, the fix and follow-ups",
  "update the runbook for gateway 502s with what we learned today",
  "check that every region is green again and list anything still degraded",
];
