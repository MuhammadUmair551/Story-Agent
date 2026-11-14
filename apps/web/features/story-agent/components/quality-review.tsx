"use client";

import { useState } from "react";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea } from "@workspace/ui";
import type { StoryAgentPlan, StoryAgentQualityReport, StoryAgentRun } from "../story-agent.types";
import { createStoryAgentClient } from "../story-agent.client";
import { IntelligenceReview } from "./intelligence-review";

const artifacts = (plan: StoryAgentPlan): Readonly<{ path: string; label: string }>[] => [
  { path: "initiative", label: `Initiative: ${plan.initiative.title}` },
  ...plan.initiative.epics.flatMap((epic, e) => {
    const ep = `initiative.epics.${String(e)}`;
    return [{ path: ep, label: `Epic: ${epic.title}` }, ...epic.features.flatMap((feature, f) => {
      const fp = `${ep}.features.${String(f)}`;
      return [{ path: fp, label: `Feature: ${feature.title}` }, ...feature.stories.flatMap((story, s) => {
        const sp = `${fp}.stories.${String(s)}`;
        return [{ path: sp, label: `Story: ${story.title}` }, ...story.tasks.map((task, t) => ({ path: `${sp}.tasks.${String(t)}`, label: `Task: ${task.title}` }))];
      })];
    })];
  })
];

const selectedValue = (plan: StoryAgentPlan, path: string): unknown => path.split(".").reduce<unknown>((value, part) => typeof value === "object" && value !== null && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined, plan);

const fieldLabel = (field: string): string => ({ metadata: "Story context", states: "States", dependsOn: "Dependencies", openQuestions: "Open questions", sliceRationale: "Slice rationale", acceptanceCriteria: "Acceptance criteria", intent: "Benefit", outcome: "Outcome", objective: "Objective", title: "Title", description: "Description", effort: "Effort", epics: "Epics", features: "Features", stories: "Stories", tasks: "Tasks" })[field] ?? field;

const ArtifactSnapshot = ({ value }: Readonly<{ value: unknown }>): React.JSX.Element => {
  if (Array.isArray(value)) return <ol>{value.map((item: unknown, index) => <li key={index}><ArtifactSnapshot value={item} /></li>)}</ol>;
  if (typeof value === "object" && value !== null) return <dl>{Object.entries(value).filter(([field]) => field !== "artifactId").map(([field, item]: [string, unknown]) => <div key={field}><dt>{fieldLabel(field)}</dt><dd><ArtifactSnapshot value={item} /></dd></div>)}</dl>;
  return <span>{typeof value === "string" ? value : "—"}</span>;
};

const changeLabel = (path: string): string => path.split(".").filter((part) => !["initiative", "epics", "features", "stories", "tasks"].includes(part)).map((part) => /^\d+$/.test(part) ? String(Number(part) + 1) : fieldLabel(part)).join(" / ");

const QualityFeedback = ({ quality, path }: Readonly<{ quality: StoryAgentQualityReport; path: string }>): React.JSX.Element => <div className="forge-quality-checks">
  <p>Blocking checks: {quality.status}. Advisory checks guide human review.</p>
  {quality.checks.filter((check) => check.artifactPath === path || check.status === "failed").map((check, index) => <details key={`${check.artifactPath}-${check.dimension}-${String(index)}`}>
    <summary>{check.dimension.replaceAll("_", " ")} · {check.status.replaceAll("_", " ")} — {check.issue}</summary>
    <dl><dt>Reason</dt><dd>{check.reason}</dd><dt>Impact</dt><dd>{check.impact}</dd><dt>Suggested fix</dt><dd>{check.suggestedFix}</dd></dl>
  </details>)}
</div>;

export const QualityReview = ({ run, client, onUpdated }: Readonly<{ run: StoryAgentRun; client: ReturnType<typeof createStoryAgentClient>; onUpdated: (run: StoryAgentRun) => void }>): React.JSX.Element => {
  const [path, setPath] = useState("initiative");
  const [instructions, setInstructions] = useState("Clarify scope and improve the applicable quality findings without inventing requirements.");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (run.status !== "draft" || !run.plan) return <p role="status">A validated delivery plan is required before quality review or refinement.</p>;
  const options = run.plan ? artifacts(run.plan) : [];
  const pending = run.refinements?.find((proposal) => proposal.status === "pending");
  const perform = async (operation: () => Promise<void>, success: string): Promise<void> => {
    setBusy(true); setMessage("");
    let saved = false;
    try { await operation(); saved = true; setMessage(success); const detail = await client.getRun(run.runId); onUpdated(detail.run); }
    catch (error: unknown) { setMessage(saved ? "Your request was saved, but the entry could not be refreshed. Reload the saved entry to see its current state." : error instanceof Error ? error.message : "The change could not be saved. Reload the entry and try again."); }
    finally { setBusy(false); }
  };
  return <section className="forge-quality" aria-label="Quality and refinement">
    <h3>Quality & refinement</h3>
    <Button variant="outline" disabled={busy} onClick={() => { void perform(() => Promise.resolve(), "Saved entry reloaded."); }}>Reload saved entry</Button>
    <p>Review a hierarchy artifact, then request a proposal. Your active plan changes only when you accept.</p>
    {options.length ? <Select value={path} onValueChange={setPath} disabled={busy || Boolean(pending)}><SelectTrigger aria-label="Artifact to review"><SelectValue /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.path} value={option.path}>{option.label}</SelectItem>)}</SelectContent></Select> : null}
    {run.quality ? <QualityFeedback quality={run.quality} path={path} /> : <p>Reopen the saved entry to load its quality review.</p>}
    {run.plan && !pending ? <><Textarea aria-label="Refinement request" maxLength={2000} value={instructions} onChange={(event) => setInstructions(event.target.value)} disabled={busy} /><Button disabled={busy || !instructions.trim()} onClick={() => { void perform(() => client.proposeRefinement(run.runId, { artifactPath: path, instructions: instructions.trim(), version: run.refinementVersion ?? 0 }), "Proposal saved. Review the changes before deciding."); }}>{busy ? "Preparing proposal…" : "Propose refinement"}</Button></> : null}
    {pending ? <article className="forge-proposal" aria-label="Refinement proposal">
      <h4>Proposed revision</h4>
      {pending.requirementChange ? <dl><dt>Original requirement</dt><dd>{pending.requirementChange.original}</dd><dt>Proposed requirement</dt><dd>{pending.requirementChange.proposed}</dd></dl> : null}
      <p>{options.find((option) => option.path === pending.artifactPath)?.label ?? pending.artifactPath}</p>
      {pending.changes.map((change) => <div key={change.path}><b>{changeLabel(change.path)}</b><p>{change.explanation}</p><p>Reason: {change.reason}</p></div>)}
      <div className="forge-proposal__comparison"><div><h5>Original artifact</h5><div className="forge-snapshot"><ArtifactSnapshot value={selectedValue(pending.original, pending.artifactPath)} /></div></div><div><h5>Proposed artifact</h5><div className="forge-snapshot"><ArtifactSnapshot value={selectedValue(pending.proposed, pending.artifactPath)} /></div></div></div>
      <details><summary>Proposed quality feedback</summary><QualityFeedback quality={pending.quality} path={pending.artifactPath} /></details>
      <Button disabled={busy} onClick={() => { void perform(() => client.decideRefinement(run.runId, pending.id, "accept", run.refinementVersion ?? 0), "Refinement accepted. The original remains in revision history."); }}>Accept proposal</Button>
      <Button variant="outline" disabled={busy} onClick={() => { void perform(() => client.decideRefinement(run.runId, pending.id, "reject", run.refinementVersion ?? 0), "Proposal rejected. The active plan is unchanged."); }}>Reject proposal</Button>
    </article> : null}
    {run.refinements?.filter((proposal) => proposal.status !== "pending").map((proposal) => <details key={proposal.id}><summary>{proposal.status} revision · {proposal.decidedAt}</summary>{proposal.requirementChange ? <dl><dt>Original requirement</dt><dd>{proposal.requirementChange.original}</dd><dt>Proposed requirement</dt><dd>{proposal.requirementChange.proposed}</dd></dl> : null}{proposal.changes.map((change) => <p key={change.path}>{changeLabel(change.path)}: {change.explanation} {change.reason}</p>)}<h5>Original</h5><div className="forge-snapshot"><ArtifactSnapshot value={selectedValue(proposal.original, proposal.artifactPath)} /></div><h5>Proposed</h5><div className="forge-snapshot"><ArtifactSnapshot value={selectedValue(proposal.proposed, proposal.artifactPath)} /></div></details>)}
    {run.status === "draft" ? <IntelligenceReview key={`${run.runId}:${run.requirement}`} run={run} client={client} onUpdated={onUpdated} /> : null}
    <p role="status" aria-live="polite">{message}</p>
  </section>;
};
