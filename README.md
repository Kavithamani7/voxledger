# VoxLedger

**VoxLedger** is a voice-first personal finance assistant that lets a user register, unlock the app with their voice, manage budgets, track expenses, read notifications, navigate pages, and ask finance-related questions using natural spoken English.

It combines a **React + Vite frontend** with a **FastAPI backend**, **SQLite database**, **Whisper speech-to-text**, **MFCC-based voice authentication**, and **gTTS text-to-speech**.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Key Features](#key-features)
3. [Tech Stack](#tech-stack)
4. [How the Project Works](#how-the-project-works)
5. [Project Structure](#project-structure)
6. [Prerequisites](#prerequisites)
7. [How to Run the Project](#how-to-run-the-project)
8. [First-Time Usage](#first-time-usage)
9. [How to Use the Voice Assistant](#how-to-use-the-voice-assistant)
10. [Supported Voice Commands](#supported-voice-commands)
11. [How to Reset or Delete Existing User Data](#how-to-reset-or-delete-existing-user-data)
12. [Troubleshooting](#troubleshooting)
13. [Backend and Frontend Ports](#backend-and-frontend-ports)
14. [Security Notes](#security-notes)
15. [Future Improvements](#future-improvements)

---

## Project Overview

VoxLedger is designed as a **hands-free finance assistant**. The user can interact with the application through voice instead of depending only on buttons and text input.

The system supports:

- user registration
- voice sample recording
- voice-based unlock/authentication
- monthly income setup
- monthly and category budget management
- expense logging
- transactions history
- unread notifications
- alert reading
- page navigation by voice
- dark mode voice control
- finance-related queries and insights

The project aims to feel like a secure, practical assistant that understands the app and performs the correct action from spoken input.

---

## Key Features

### Voice Authentication
- Register with a name, password, and voice sample
- Unlock the app using the registered voice
- Reject silence, random noise, and most invalid audio
- Compare spoken input against stored voice embeddings

### Voice-Driven Finance Actions
- Set monthly income
- Set monthly budget
- Set category budgets
- Add expenses using natural speech
- Support both default and user-created categories

### App Navigation by Voice
- Open dashboard
- Open budget page
- Open transactions
- Open notifications
- Open alerts
- Open profile
- Open Add Voice Sample page
- Open conversation page

### Notifications and Alerts
- Read unread notifications
- Read all notifications
- Read first or second notification
- Mark all notifications as read
- Read alerts, critical alerts, warnings, and informational alerts

### Smart Queries
- Check total spending
- Check remaining balance
- Ask for user details like name and income
- Ask for insights and analytics
- Query transactions by time/date where supported

### Voice Assistant Controls
- Stop speaking immediately with `Stop`
- Ignore many non-app and hallucinated transcripts
- Support short and long command styles
- Work with simple English phrasing

### UI Features
- Dark mode / light mode switching by voice
- Auto-lock after inactivity
- Profile and voice sample management
- Conversation history

---

## Tech Stack

### Frontend
- **React 18**
- **TypeScript**
- **Vite**
- **Tailwind CSS**
- **React Router**
- **Radix UI**
- **Framer Motion**
- **TanStack React Query**

### Backend
- **FastAPI**
- **Uvicorn**
- **Pydantic**
- **SQLite**
- **NumPy / SciPy / scikit-learn**

### Audio / AI / Speech
- **OpenAI Whisper** for speech-to-text
- **librosa** for audio processing and MFCC features
- **gTTS** for text-to-speech
- **ffmpeg** for audio conversion and speed adjustment

---

## How the Project Works

### Complete Flow
1. The frontend records audio from the browser microphone.
2. Audio is sent to the backend.
3. The backend cleans and analyzes the audio.
4. If needed, voice authentication checks whether the speaker matches the registered user.
5. Whisper converts speech to text.
6. The backend detects the user’s intent.
7. The correct action is performed:
   - navigate page
   - update budget
   - add expense
   - read notifications
   - answer a query
8. The backend generates a spoken response.
9. The frontend plays the assistant response.

### Authentication Flow
1. User records a secure voice sample during registration.
2. Backend stores a voice embedding in the database.
3. At unlock time, spoken audio is converted into a probe embedding.
4. Cosine similarity is computed against stored embeddings.
5. Access is granted only if the match is strong enough.

### Finance Flow
Example:
- User says: `I spent two hundred on food`
- Whisper transcribes the sentence
- Intent parser identifies **add expense**
- Amount = `200`
- Category = `Food`
- Transaction is stored in SQLite
- Assistant replies with confirmation

---

## Project Structure

```text
VoxLedger_v9_Final/
│
├── VoxLedger_backend/
│   ├── main.py
│   ├── config.py
│   ├── database.py
│   ├── reset_db.py
│   ├── requirements.txt
│   ├── start_backend.ps1
│   ├── start_backend.sh
│   ├── routes/
│   ├── services/
│   ├── utils/
│   ├── database/
│   ├── voice_samples/
│   └── tts_output/
│
├── VoxLedger_frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── start.ps1
│   ├── start_frontend.sh
│   ├── src/
│   └── public/
│
└── README.md
```

### Important Files

#### Backend
- `main.py` — starts the FastAPI application
- `database.py` — creates and manages the SQLite tables
- `config.py` — central configuration values
- `reset_db.py` — clears existing user data and resets the app
- `routes/voice_routes.py` — main voice command pipeline
- `services/voice_auth_service.py` — voice authentication logic
- `services/whisper_service.py` — speech-to-text logic
- `services/tts_service.py` — text-to-speech generation
- `utils/intent_parser.py` — identifies user intent from text

#### Frontend
- `package.json` — frontend scripts and dependencies
- `src/` — application pages, components, and voice UI logic
- `start.ps1` — Windows helper script to start frontend quickly

---

## Prerequisites

Install these before running the project:

- **Python 3.10 or above**
- **Node.js 18 or above**
- **npm**
- **ffmpeg** added to system PATH

### Install ffmpeg

#### Windows
Use either:
```powershell
winget install ffmpeg
```

Or download ffmpeg manually and add it to your PATH.

#### macOS
```bash
brew install ffmpeg
```

#### Ubuntu / Debian
```bash
sudo apt update
sudo apt install ffmpeg
```

---

## How to Run the Project

You need **two terminals**:
- one for backend
- one for frontend

### Backend Startup

#### Windows PowerShell (recommended)
Open PowerShell inside `VoxLedger_backend` and run:

```powershell
.\start_backend.ps1
```

This script will:
- create a virtual environment if missing
- activate it
- install requirements
- start FastAPI on port `8000`

#### Manual Backend Start (Windows / macOS / Linux)

```bash
cd VoxLedger_backend
python -m venv venv
```

Activate the virtual environment:

**Windows**
```powershell
venv\Scripts\activate
```

**macOS / Linux**
```bash
source venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

Run the backend:

```bash
uvicorn main:app --reload --port 8000
```

Backend URL:
```text
http://127.0.0.1:8000
```

API docs:
```text
http://127.0.0.1:8000/docs
```

---

### Frontend Startup

#### Windows PowerShell (recommended)
Open a new PowerShell window inside `VoxLedger_frontend` and run:

```powershell
.\start.ps1
```

#### Manual Frontend Start

```bash
cd VoxLedger_frontend
npm install
npm run dev
```

Frontend URL:
```text
http://localhost:5173
```

---

## First-Time Usage

1. Start the backend.
2. Start the frontend.
3. Open `http://localhost:5173` in your browser.
4. The splash screen checks whether a user already exists.
5. If no user exists, go to the registration page.
6. Register with:
   - name
   - password
   - voice sample
7. Record the secure voice sample clearly.
8. After registration, use voice authentication to unlock the app.

### Recommended Registration Voice Sample
Use a longer phrase like:

> Hello VoxLedger, this is my secure voice sample for authentication. I will use this voice to access my finance assistant.

This improves the uniqueness of the stored voice pattern.

---

## How to Use the Voice Assistant

### Basic Use Pattern
1. Unlock the app with your voice
2. Open the page you want or directly speak a command
3. Wait for the assistant to process the request
4. Hear the response
5. Say `Stop` anytime to interrupt speaking

### Good Speaking Tips
- speak clearly
- avoid fan or TV noise nearby
- do not whisper during authentication
- keep a small pause before speaking
- use a normal speaking voice
- stay reasonably close to the microphone

---

## Supported Voice Commands

### Authentication / Profile
- `Unlock VoxLedger`
- `Authenticate me`
- `I want to add another voice sample`
- `I need to add one more voice profile`
- `Go to profile page`
- `What is my name?`
- `What is my monthly income?`
- `How many voice samples do I have?`

### Navigation
- `Open dashboard`
- `Open budget page`
- `Open transactions`
- `Open notifications`
- `Open alerts`
- `Open profile`
- `Open conversation page`
- `Open add voice sample page`

### Budget Commands
- `Set my monthly budget to fifty thousand`
- `Set food category budget to 2000`
- `Set transport budget to 1000`
- `Show my budget`

### Income Commands
- `Set my monthly income to one lakh`
- `Update my monthly income`
- `What is my monthly income?`

### Expense Commands
- `Add 200 food`
- `Add two hundred rupees for food`
- `Please log two hundred rupees for food expenses`
- `I spent 500 on shopping`
- `Spend 100 on skincare`

### Query Commands
- `How much did I spend?`
- `What is my total spending?`
- `How much money have I spent?`
- `What is my remaining balance?`
- `What balance do I have left?`
- `Give me my spending insight`
- `Show my insights`

### Notification Commands
- `Read notifications`
- `Read unread notifications`
- `Read first notification`
- `Read second notification`
- `Mark all notifications as read`

### Alert Commands
- `Read alerts`
- `Read critical alerts`
- `Read warnings`
- `Read info alerts`

### Dark Mode Commands
- `Turn on dark mode`
- `Enable dark mode`
- `Switch to dark theme`
- `Turn off dark mode`
- `Switch to light mode`

### Delete / Dangerous Commands
- `Delete first transaction`
- `Delete second transaction`
- `Confirm delete`

### Stop Command
- `Stop`
- `Stop speaking`

---

## How to Reset or Delete Existing User Data

If you want to remove all old users and register a fresh new user, use the backend reset script.

### Method 1: Recommended
Go to the backend folder and run:

```bash
cd VoxLedger_backend
python reset_db.py
```

This clears user-related data from the database, including:
- users
- voice embeddings
- notifications
- transactions
- budgets
- conversation history

After running it, open the frontend again and register a new user.

### Method 2: Manual File Reset
The SQLite database is stored at:

```text
VoxLedger_backend/database/voxledger.db
```

If needed, you can stop the backend and delete this database file manually, then restart the backend so tables are recreated.

---

## Troubleshooting

### 1. Backend not starting
Check:
- Python is installed
- virtual environment is activated
- `pip install -r requirements.txt` completed successfully
- port `8000` is free

### 2. Frontend not starting
Check:
- Node.js is installed
- `npm install` completed successfully
- port `5173` is free

### 3. Voice commands not working
Check:
- browser microphone permission is allowed
- backend is running
- frontend is running
- you are speaking clearly
- environment noise is low

### 4. Voice authentication failing
Check:
- a voice sample was actually saved during registration
- you are using the same voice/user
- the voice sample was recorded clearly
- you are not too far from the mic

If needed, reset the database and register again with a cleaner voice sample.

### 5. ffmpeg not found
If backend logs mention ffmpeg issues:
- install ffmpeg
- add it to PATH
- restart terminal after installation

### 6. Whisper is slow
Whisper runs on CPU by default on many systems, so the first few requests may feel slower.

---

## Backend and Frontend Ports

| Service | Port | URL |
|--------|------|-----|
| Backend | 8000 | `http://127.0.0.1:8000` |
| Frontend | 5173 | `http://localhost:5173` |

---

## Security Notes

- Passwords exist in the project flow for login/registration, but sensitive details should never be spoken back by the assistant.
- Voice authentication should be used for access control, but it should always be tested carefully in noisy real-world environments.
- Destructive actions such as transaction deletion should require confirmation.
- If you plan to deploy this project publicly, improve:
  - password storage security
  - session management
  - HTTPS usage
  - production database setup
  - production-grade authentication rules

---

## Future Improvements

Possible future upgrades:
- better speaker verification model
- stronger noise rejection for cough and room sounds
- multilingual support
- real-time live VAD on frontend
- cloud database instead of SQLite
- downloadable reports
- charts and richer analytics insights
- mobile app version
- role-based multi-user voice profiles

---

## Summary

VoxLedger is a complete voice-first finance assistant project built for:
- secure voice login
- personal finance tracking
- budget management
- voice navigation
- smart finance queries

To use it:
1. start backend
2. start frontend
3. register a user
4. record a voice sample
5. unlock with voice
6. manage finance operations using speech

