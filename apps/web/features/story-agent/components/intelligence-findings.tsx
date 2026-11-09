"use client";

import { useState } from "react";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@workspace/ui";
import type { StoryAgentAnalysis, StoryAgentIntelligenceFinding } from "@workspace/types";
import type { StoryAgentRun } from "../story-agent.types";
import type { createStoryAgentClient } from "../story-agent.client";
import { analysisIsStale, filterFindings } from "../story-agent.intelligence";

const Filter = ({ label, value, values, onChange }: Readonly<{ label: string; value: string; values: readonly string[]; onChange: (value: string) => void }>) => <label>{label}<Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger><SelectContent>{values.map((item) => <SelectItem key={item} value={item}>{item.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></label>;
type ReviewProps = Readonly<{ run: StoryAgentRun; analysis: StoryAgentAnalysis; client: ReturnType<typeof createStoryAgentClient>; busy: boolean; perform: (operation: () => Promise<void>) => Promise<void> }>;

const FindingCard = ({ finding, run, analysis, client, busy, perform }: ReviewProps & Readonly<{ finding: StoryAgentIntelligenceFinding }>) => {
  const [reason, setReason] = useState("");
  const stale = analysisIsStale(run, analysis);
  const status = finding.review?.status ?? "open";
  const pending = run.refinements?.some((item) => item.status === "pending");
  const decide = (decision: "confirm" | "dismiss" | "reopen") => { void perform(() => client.decideFinding(run.runId, analysis.id, finding.id, { decision, reason: reason.trim(), reviewVersion: analysis.reviewVersion ?? 0 })); };
  return <article aria-label={`${finding.kind.replaceAll("_", " ")} finding`}>
    <h4>{finding.kind.replaceAll("_", " ")} · {finding.evidence.find((item) => item.runId === run.runId && item.artifactPath === finding.artifactPath)?.breadcrumb?.join(" → ") ?? finding.artifactPath}</h4>
    <p>Evidence method: {finding.method === "title_match" ? "Title and context match; behavior overlap needs review" : "Provider semantic review; verify the evidence"}. Review status: {status}.</p>
    <p>{finding.reason}</p><p>Suggested update: {finding.suggestedUpdate}</p>
    <div className="forge-evidence" aria-label="Side-by-side evidence">{finding.evidence.map((item, index) => <div key={index} className="forge-evidence__field"><b>{item.breadcrumb?.join(" → ") ?? `${item.runId} / ${item.artifactPath}`}</b><small>Saved entry: {item.runId}</small>{item.fieldPath ? <p>Field: {item.fieldPath}</p> : null}<blockquote>{item.fieldValue !== undefined && item.start !== undefined && item.end !== undefined ? <>{item.fieldValue.slice(0, item.start)}<mark>{item.fieldValue.slice(item.start, item.end)}</mark>{item.fieldValue.slice(item.end)}</> : item.quote}</blockquote></div>)}</div>
    {finding.counterparts?.length ? <p>Counterparts: {finding.counterparts.map((item) => `${item.runId} / ${item.breadcrumb?.join(" → ") ?? item.artifactPath}`).join("; ")}</p> : null}
    <p>Affected dependency references: {finding.dependencies.map((item) => `${item.runId} / ${item.artifactPath}`).join(", ") || "none reported"}</p>
    {analysis.evidenceVersion === 2 ? <fieldset disabled={busy || stale}><legend>Review this finding</legend><label>Reason for review decision<Textarea value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} /></label><div className="forge-finding-actions"><Button disabled={status === "confirmed"} onClick={() => decide("confirm")}>Confirm finding</Button><Button variant="outline" disabled={status === "dismissed" || !reason.trim()} onClick={() => decide("dismiss")}>Dismiss with reason</Button><Button variant="outline" disabled={status === "open"} onClick={() => decide("reopen")}>Reopen finding</Button></div></fieldset> : <p>Run an evidence-based backlog review to record finding decisions.</p>}
    {finding.review?.history.length ? <details><summary>Finding decision history</summary>{finding.review.history.map((item, index) => <p key={index}>{item.decision} · {item.at}{item.reason ? ` · ${item.reason}` : ""}</p>)}</details> : null}
    <Button disabled={busy || pending || stale || status === "dismissed"} onClick={() => { void perform(() => client.proposeRefinement(run.runId, { artifactPath: finding.artifactPath, instructions: `Review and apply this suggestion without changing unrelated artifacts: ${finding.suggestedUpdate}`, version: run.refinementVersion ?? 0, analysisId: analysis.id, findingId: finding.id })); }}>Prepare proposed update</Button>
  </article>;
};

export const IntelligenceFindings = (props: ReviewProps) => {
  const { analysis, run } = props;
  const [level, setLevel] = useState("all"); const [kind, setKind] = useState("all"); const [status, setStatus] = useState("all");
  const findings = filterFindings(analysis.findings, { level, kind, status });
  return <>
    {analysis.coverage ? <div role={analysis.coverage.status === "partial" ? "alert" : "status"}><p>Selected-scope coverage: {analysis.coverage.status}. Reviewed {analysis.coverage.reviewedArtifacts} of {analysis.coverage.totalArtifacts} artifacts. This is the provider’s reported coverage, not proof that every semantic issue was found.</p>{analysis.coverage.reasons.map((reason) => <p key={reason}>{reason}</p>)}{analysis.coverage.excluded.length ? <details><summary>Artifacts not reviewed</summary>{analysis.coverage.excluded.map((item) => <p key={`${item.runId}:${item.artifactPath}`}>{item.runId} / {item.breadcrumb?.join(" → ") ?? item.artifactPath}</p>)}</details> : null}</div> : <p>Detailed artifact coverage was not recorded for this historical report.</p>}
    <div className="forge-finding-filters"><Filter label="Finding level" value={level} values={["all", "initiative", "epic", "feature", "story", "task"]} onChange={setLevel} /><Filter label="Finding type" value={kind} values={["all", "duplicate_behavior", "contradiction", "terminology", "affected", "stale", "incomplete"]} onChange={setKind} /><Filter label="Finding status" value={status} values={["all", "open", "confirmed", "dismissed"]} onChange={setStatus} /></div>
    <p>Showing {findings.length} of {analysis.findings.length} findings.</p>
    {findings.map((finding) => <FindingCard key={finding.id} {...props} finding={finding} />)}
    {!findings.length ? <p>{analysis.findings.length ? "No findings match these filters." : "No supported findings returned for this scope. This does not establish absence of semantic problems."}</p> : null}
    {analysisIsStale(run, analysis) ? <p role="alert">This review is historical or its evidence changed. Analyze the current saved entry again before reviewing findings or preparing another update.</p> : null}
  </>;
};
