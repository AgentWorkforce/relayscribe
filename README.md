# Agent Relay — Relayscribe

Native macOS menu-bar recorder that captures meeting audio locally — **no bot joins your call, and recordings are never stored.**

[![Download for macOS](https://img.shields.io/badge/Download-Agent_Relay_for_macOS-black?style=for-the-badge&logo=apple)](https://github.com/AgentWorkforce/relayscribe/releases/latest/download/AgentRelay.dmg)

**Requires macOS 14+.** Transcription requires a Relay account — [email hi@agentrelay.com](mailto:hi@agentrelay.com) to become a design partner.

---

## How it works

**Relayscribe has one job: transcribe.** It captures your meeting or brainstorm locally (no bot joins your call), sends the audio to the transcription backend, and drops the result into your Relay workspace at `/recall/recordings/<id>.json`.

**The proactive agent does everything else.** When the transcript lands, the listening agent persona fires — extracting action items, filing issues, opening PRs, writing to Notion, pinging Slack, or whatever flow you configure. Relayscribe is agnostic to all of it.

```
Meeting / brainstorm audio
  └─ Relayscribe (this app) ──► /recall/recordings/<id>.json
                                         │
                                         ▼
                               Proactive agent persona  ◄── you choose this
                                         │
                          ┌──────────────┼──────────────┐
                          ▼              ▼              ▼
                       Linear         GitHub          Slack
                       Notion         GitLab        HubSpot
                      (anything)    (anything)    (anything)
```

**Meeting mode** — detects active meeting windows (Zoom, Teams, Google Meet, etc.) and records system audio via the Recall Desktop SDK.

**Brainstorm mode** — records your mic directly from the menu bar. Tap, speak, stop.

---

## Privacy-first by design

The AI-notetaker category has a trust problem: meeting bots that announce themselves to the room, vendors that retain your audio indefinitely, and tools that train their models on your conversations by default. The result — [84% of professionals change how they speak when a bot is recording](https://basilai.app/articles/2026-05-11-ai-meeting-bots-chilling-effect-self-censorship-workplace-speech-on-device-privacy.html), and universities, law firms, and regulated industries are banning bot notetakers outright.

Relayscribe takes the opposite posture:

- **No bot ever joins your call.** Audio is captured locally from your own machine via the Recall Desktop SDK — nothing appears in the participant list, nothing announces itself, no one alters how they speak. Other attendees never know a notetaker is running.
- **Recordings are never stored.** The audio file is deleted the moment its transcript is produced ([`recording-persistence.ts`](./sidecar/src/recording-persistence.ts) `unlink`s it on success). We keep the transcript, not the recording — there is no audio archive to leak, subpoena, or breach.
- **Your transcripts live in your workspace.** They land in your own Relay workspace, which you control. Downstream routing (Linear, Notion, Slack, anything) is configured by you and goes only where you send it.
- **No training on your data.** Your conversations are never used to train models — on any plan, not as a paid Enterprise add-on.
- **First-party transcription.** Speech-to-text runs on our own model deployment (the National Library of Norway's NB-Whisper, Apache-2.0), not a grab-bag of third-party AI APIs with vendor keys that can leak.
- **White-label & bring-your-own-backend.** We ship white-labeled builds for partners who want the recorder under their own brand, and the backend is yours to self-host — a viable path for regulated industries that cannot send audio to a shared cloud.

---

## Proactive agent personas

The [`agents/`](./agents/) directory contains ready-to-deploy personas. Each one listens for the same transcript trigger and takes a different action. Deploy one, deploy several, or write your own.

| Persona | Flow | Best for | Deploy |
|---------|------|----------|--------|
| [`transcript-to-linear-github`](./agents/transcript-to-linear-github/) | transcript → Linear issues → GitHub PRs | Engineering teams — coding tasks go all the way to a PR, autonomously | [![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/relayscribe/blob/main/agents/transcript-to-linear-github/persona.ts) |
| [`transcript-slack-digest`](./agents/transcript-slack-digest/) | transcript → Slack digest | Any team — lightweight, no issue tracker required | [![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/relayscribe/blob/main/agents/transcript-slack-digest/persona.ts) |
| [`transcript-to-notion-slack`](./agents/transcript-to-notion-slack/) | transcript → Notion page → Slack link | Product / ops teams who live in Notion | [![Launch Agent](https://agentrelay.com/launch-agent_small.svg)](https://agentrelay.com/cloud/deploy?persona=https://github.com/AgentWorkforce/relayscribe/blob/main/agents/transcript-to-notion-slack/persona.ts) |

The personas are also listed in the [Agent Workforce registry](https://github.com/AgentWorkforce/agents). You can swap integrations (Linear → Jira, GitHub → GitLab, Slack → HubSpot) by writing a new persona — the `persona.ts` file is the only thing that changes.

---

## Language support

Relayscribe uses a Whisper-based transcription backend with particularly strong Scandinavian dialect coverage — including spoken dialects that trip up most transcription services.

### Norwegian
- **Bokmål** — standard written Norwegian, eastern/urban speech
- **Nynorsk** — western Norwegian written standard
- **Sunnmøre** — Ålesund, Stranda, Ørsta, Volda (the Møre og Romsdal coastal dialects)
- **Vestland** — Bergen (Bergensk), Sogning, Sunnfjord
- **Trøndersk** — Trondheim and surrounding regions
- **Nordnorsk** — Tromsø, Bodø, Lofoten
- **Østlandsk** — Oslo-area and eastern valley dialects (Gudbrandsdal, Hedmark)
- **Rogalandsk** — Stavanger and Jæren

### Other Scandinavian
- **Swedish** — Rikssvenska, Skånska, Göteborgska, Norrländska
- **Danish** — standard Rigsdansk and Copenhagen speech
- **Faroese**
- **Icelandic**
- **Finnish** — including Finland-Swedish (Finlandssvenska)

### Other languages
- **English**, **German**, **French**, **Spanish**, **Portuguese**, **Italian**, **Dutch**
- **Japanese**, **Korean**, **Chinese (Mandarin and Cantonese)**
- 90+ additional languages — if Whisper supports it, so does Relayscribe

### Setting the language

Relayscribe defaults to **Norwegian** (`no`) and routes to the National Library of
Norway's NB-Whisper model — tuned across Norway's dialects. The language is a
recorder setting; override it with the `RELAYSCRIBE_LANGUAGE` env var (BCP-47-ish
code, or `auto` to let Whisper detect from audio):

```bash
RELAYSCRIBE_LANGUAGE=sv   # Swedish → KB-Whisper (National Library of Sweden)
RELAYSCRIBE_LANGUAGE=no   # Norwegian (default) → NB-Whisper
RELAYSCRIBE_LANGUAGE=auto # detect per recording
```

The transcription backend maps each language to its best-fit model server-side,
so setting the language is all that's needed — no per-language configuration in
the app.

---

## Getting started

1. Download `AgentRelay.dmg` above, drag the app to Applications, and launch it.
2. The app appears in your menu bar — click the icon to open it.
3. Sign in to your Relay workspace from the Settings menu. This is required to unlock transcription.
4. Connect your integrations (Slack, Linear, GitHub) from the Integrations menu.
5. Relayscribe is now active. Meeting mode starts automatically when a supported meeting window is detected. Use Brainstorm mode to record on demand.

> Not a design partner yet? Email [hi@agentrelay.com](mailto:hi@agentrelay.com) to get access.

