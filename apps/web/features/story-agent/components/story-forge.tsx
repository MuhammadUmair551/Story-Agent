"use client";

import {
  Aperture, ArrowUpRight, Archive, BookOpen, Check, ChevronRight, Clipboard, Copy, Feather, Layers,
  LoaderCircle, Menu, Plus, Search, Sparkles, WandSparkles, X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@workspace/ui";
import { buildStoryAgentRunCopyText, createStoryAgentClient, filterStoryAgentRuns } from "../story-agent.client";
import type { StoryAgentPlan, StoryAgentRun, StoryAgentStory } from "../story-agent.types";

type StoryForgeProps = Readonly<{ apiBaseUrl: string }>;
type View = "forge" | "archive";

const prompts = [
  "A returning reader saves a chapter and resumes it on another device",
  "A creator can invite an editor to a private story world",
  "A player discovers and follows a branching quest"
] as const;

const copyStory = (story: StoryAgentStory): string => [
  `Title: ${story.title}`, `Intent: ${story.intent}`, `Epic: ${story.epic}`,
  "Acceptance criteria:", ...story.acceptanceCriteria.map((criterion) => `- ${criterion}`)
].join("\n");

const statusLabel = (status: StoryAgentRun["status"]): string => ({ draft: "Ready", queued: "In queue", questions: "Needs a choice", failed: "Needs repair" })[status];

const StoryCard = ({ story, index, onCopy }: Readonly<{ story: StoryAgentStory; index: number; onCopy: (text: string) => void }>): React.JSX.Element => (
  <article className="forge-story-card">
    <div className="forge-story-card__number">{String(index + 1).padStart(2, "0")}</div>
    <div className="forge-story-card__topline"><span>{story.epic}</span><span className="forge-size">{story.size}</span></div>
    <h3>{story.title}</h3>
    <p>{story.intent}</p>
    <div className="forge-criteria">
      {story.acceptanceCriteria.slice(0, 2).map((criterion) => <div key={criterion}><Check aria-hidden="true" />{criterion}</div>)}
    </div>
    <button type="button" className="forge-copy" onClick={() => onCopy(copyStory(story))}><Copy aria-hidden="true" /> Copy story</button>
  </article>
);

const DeliveryPlan = ({ plan, onCopy }: Readonly<{ plan: StoryAgentPlan; onCopy: (text: string) => void }>): React.JSX.Element => (
  <section className="delivery-plan" aria-label="Delivery hierarchy">
    <div className="delivery-initiative"><span>Initiative</span><div><h3>{plan.initiative.title}</h3><p>{plan.initiative.outcome}</p></div></div>
    {plan.initiative.epics.map((epic, epicIndex) => <article className="delivery-epic" key={epic.title}>
      <header><span>EPIC {String(epicIndex + 1).padStart(2, "0")}</span><div><h3>{epic.title}</h3><p>{epic.objective}</p></div></header>
      {epic.features.map((feature) => <section className="delivery-feature" key={feature.title}><div className="delivery-feature__heading"><Layers /><div><span>Feature</span><h4>{feature.title}</h4><p>{feature.outcome}</p></div></div><div className="delivery-stories">{feature.stories.map((story, storyIndex) => <article key={story.title} className="delivery-story"><div><span>Story {String(storyIndex + 1).padStart(2, "0")}</span><h5>{story.title}</h5><p>{story.intent}</p></div><ul>{story.tasks.map((task) => <li key={task.title}><i>{task.effort}</i><span><b>{task.title}</b><small>{task.description}</small></span></li>)}</ul><button type="button" onClick={() => onCopy([`Story: ${story.title}`, `Intent: ${story.intent}`, "Tasks:", ...story.tasks.map((task) => `- ${task.title}: ${task.description}`)].join("\n"))}><Copy /> Copy work</button></article>)}</div></section>)}
    </article>)}
  </section>
);

export const StoryForge = ({ apiBaseUrl }: StoryForgeProps): React.JSX.Element => {
  const client = useMemo(() => createStoryAgentClient(apiBaseUrl), [apiBaseUrl]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const requestRef = useRef(0);
  const [view, setView] = useState<View>("forge");
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [input, setInput] = useState("");
  const [run, setRun] = useState<StoryAgentRun | null>(null);
  const [history, setHistory] = useState<StoryAgentRun[]>([]);
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadHistory = useCallback(async (): Promise<void> => {
    setIsHistoryLoading(true);
    try { setHistory(await client.listRuns()); } catch { setHistory([]); } finally { setIsHistoryLoading(false); }
  }, [client]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadHistory(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadHistory]);
  useEffect(() => {
    const focusComposer = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") { event.preventDefault(); setView("forge"); inputRef.current?.focus(); }
    };
    window.addEventListener("keydown", focusComposer);
    return () => window.removeEventListener("keydown", focusComposer);
  }, []);

  useEffect(() => {
    if (run?.status !== "queued" || !run.runId) return;
    const poll = window.setInterval(() => {
      void client.getRun(run.runId).then((detail) => setRun((current) => current?.runId === run.runId ? { ...detail.run, requirement: detail.run.requirement || current.requirement, stories: detail.draft?.stories ?? detail.run.stories } : current)).catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(poll);
  }, [client, run]);

  const writeClipboard = useCallback((text: string): void => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }).catch(() => undefined);
  }, []);
  const startFresh = useCallback((): void => { requestRef.current += 1; setRun(null); setInput(""); setView("forge"); window.setTimeout(() => inputRef.current?.focus(), 0); }, []);
  const send = useCallback(async (): Promise<void> => {
    const requirement = input.trim();
    if (!requirement || isLoading) return;
    const id = requestRef.current + 1; requestRef.current = id;
    setIsLoading(true); setRun(null);
    try { const result = await client.createRun({ requirement }); if (id === requestRef.current) { setRun({ ...result, requirement }); setInput(""); void loadHistory(); } }
    catch (error: unknown) { if (id === requestRef.current) setRun({ runId: "", status: "failed", requirement, error: error instanceof Error ? error.message : "The forge could not shape that brief." }); }
    finally { if (id === requestRef.current) setIsLoading(false); }
  }, [client, input, isLoading, loadHistory]);
  const selectRun = useCallback(async (runId: string): Promise<void> => {
    setView("forge"); setIsLoading(true);
    try { const detail = await client.getRun(runId); setRun({ ...detail.run, stories: detail.draft?.stories ?? detail.run.stories, plan: detail.draft?.plan ?? detail.run.plan }); }
    finally { setIsLoading(false); }
  }, [client]);
  const shownHistory = useMemo(() => filterStoryAgentRuns(history, query), [history, query]);
  const submit = (event: FormEvent<HTMLFormElement>): void => { event.preventDefault(); void send(); };

  return <main className="story-forge">
    <aside className={`forge-nav ${isMobileMenuOpen ? "forge-nav--open" : ""}`}>
      <div className="forge-brand"><span className="forge-brand__mark"><Feather /></span><span>tale<span>craft</span></span><button type="button" aria-label="Close navigation" onClick={() => setIsMobileMenuOpen(false)}><X /></button></div>
      <div className="forge-nav__content">
        <p className="forge-nav__label">Workshop</p>
        <button className={view === "forge" ? "is-active" : ""} type="button" onClick={() => { setView("forge"); setIsMobileMenuOpen(false); }}><WandSparkles /> Story forge</button>
        <button className={view === "archive" ? "is-active" : ""} type="button" onClick={() => { setView("archive"); setIsMobileMenuOpen(false); }}><Archive /> Story vault <span>{history.length}</span></button>
      </div>
      <div className="forge-nav__footer"><div className="forge-avatar">A</div><div><b>Adeel</b><small>Story architect</small></div><ChevronRight /></div>
    </aside>
    <section className="forge-main">
      <header className="forge-topbar"><button className="forge-menu" type="button" aria-label="Open navigation" onClick={() => setIsMobileMenuOpen(true)}><Menu /></button><div className="forge-breadcrumb"><span>Workspace</span><ChevronRight /><b>{view === "forge" ? "Story forge" : "Story vault"}</b></div><button className="forge-new" type="button" onClick={startFresh}><Plus /> New story</button></header>
      {view === "archive" ? <section className="forge-archive"><header><div><p className="forge-kicker">The record room</p><h1>Story vault</h1><p>Every idea you have asked the forge to shape.</p></div><div className="forge-mascot-mini" aria-hidden="true"><Aperture /></div></header><label className="forge-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search every story, epic, or question" /></label><div className="forge-archive__list">{isHistoryLoading ? <p>Opening the vault…</p> : shownHistory.length ? shownHistory.map((item) => <button key={item.runId} type="button" onClick={() => { void selectRun(item.runId); }}><span className="forge-archive__glyph"><BookOpen /></span><span><b>{item.requirement || "Untitled story"}</b><small>{item.stories?.length ?? 0} story slices · {statusLabel(item.status)}</small></span><ChevronRight /></button>) : <p>No stories have been saved yet. Start at the forge.</p>}</div></section> : <section className="forge-canvas">
        <div className="forge-hero"><div className="forge-hero__copy"><p className="forge-kicker">Story architecture</p><h1>What will your<br /><em>next chapter</em> change?</h1><p>Give your idea a pulse. We will find the small, testable stories hiding inside it.</p></div><div className={`forge-character ${isLoading ? "forge-character--thinking" : ""}`} aria-hidden="true"><span className="forge-spark forge-spark--one" /><span className="forge-spark forge-spark--two" /><span className="forge-character__halo" /><span className="forge-signal"><i /><i /><i /></span><div className="forge-character__note">Signal received<br /><i>shaping the thread</i></div></div></div>
        <form className="forge-prompt" onSubmit={submit}><div className="forge-prompt__top"><span className="forge-prompt__badge"><Sparkles /> Tell me a tale</span><span>⌘ J to focus</span></div><textarea ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="A reader wants to feel something new…" aria-label="Describe the product outcome you want to shape" /><div className="forge-prompt__footer"><span>Be messy. The forge likes rough ideas.</span><Button type="submit" disabled={isLoading || !input.trim()} className="forge-submit">{isLoading ? <LoaderCircle className="forge-spin" /> : <ArrowUpRight />} Shape it</Button></div></form>
        {!run && !isLoading ? <div className="forge-starters"><p>Or begin with a spark</p><div>{prompts.map((prompt, index) => <button key={prompt} type="button" onClick={() => { setInput(prompt); inputRef.current?.focus(); }}><span>0{index + 1}</span>{prompt}<ArrowUpRight /></button>)}</div></div> : null}
        {isLoading ? <div className="forge-loading"><span className="forge-loading__signal"><i /><i /><i /></span><div><b>Finding the thread…</b><p>Listening for actors, outcomes, and delightful little constraints.</p></div><span className="forge-loading__dots">•••</span></div> : null}
        {run && !isLoading ? <section className="forge-results"><header><div><p className="forge-kicker">{statusLabel(run.status)}</p><h2>{run.status === "draft" ? "Your delivery map" : "A thread to untangle"}</h2><p>{run.error ?? run.reason ?? run.message ?? "Trace the work from intent to the smallest shippable task."}</p></div><button type="button" className="forge-copy-all" onClick={() => writeClipboard(buildStoryAgentRunCopyText(run))}>{copied ? <Check /> : <Clipboard />}{copied ? "Copied" : "Copy plan"}</button></header>{run.status === "draft" && run.plan ? <DeliveryPlan plan={run.plan} onCopy={writeClipboard} /> : run.status === "draft" && run.stories?.length ? <div className="forge-story-grid">{run.stories.map((story, index) => <StoryCard key={`${story.title}-${index}`} story={story} index={index} onCopy={writeClipboard} />)}</div> : <div className="forge-question"><span>?</span><div><b>{run.requirement}</b><p>{run.questions?.join(" ") ?? "Try adjusting the shape of the idea, then send it back to the forge."}</p></div></div>}</section> : null}
      </section>}
    </section>
  </main>;
};
