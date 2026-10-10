# nanamica.ai

A Chrome extension that lets you select any text on a webpage and get instant AI-powered answers.

## Features

- **Highlight & Ask** — Select text on any page to get an instant explanation, summary, or answer
- **Multi-provider support** — Integrates Claude (Anthropic), GPT (OpenAI), and Gemini (Google) APIs
- **Configurable model selection** — Switch between providers and models from the popup UI
- **Quiz mode** — AI-assisted answer extraction for multiple-choice questions
- **Minimal UI** — Floating panel injected via content script, stays out of the way

## Architecture

- `manifest.json` — Manifest V3 Chrome extension
- `background.js` — Service worker handling ChatGPT session-based requests
- `content.js` — Content script with LLM API integration, UI rendering, and quiz logic
- `popup.html/js` — Configuration popup for API keys and model selection
- `content.css` — Floating panel styles

## Setup

1. Clone this repo
2. Go to `chrome://extensions/` → Enable Developer Mode
3. Click "Load unpacked" → Select this folder
4. Click the extension icon to configure your API key and preferred provider

## Tech Stack

JavaScript · Chrome Extensions API (Manifest V3) · Claude API · OpenAI API · Gemini API
