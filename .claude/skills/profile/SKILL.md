---
name: profile
description: Set up or check the candidate profile and voice. Use on first run, when the user says /profile, or when a form answer looked wrong. Validates data/profile.json, the resume path, and shows how answers will sound.
model: claude-sonnet-5-5
effort: high
---

# /profile: the candidate's data

1. If `data/profile.json` does not exist, copy `data/profile.example.json`
   to it and ask the user for every value, one short block at a time:
   name, contact, address, links, education (with the GPA policy), work
   authorization, demographics (they may answer "prefer not to say"),
   preferences, resume path. Write the file. Never commit it; it is
   git-ignored.
2. Validate: `npx tsx src/cli.ts answer-context --question "tell us about yourself"`.
   A schema error names the field to fix.
3. Confirm the resume exists at `resume.path` and is a PDF under 5 MB.
4. Copy `data/voice.md` to `data/voice.local.md` and read it with the user.
   Draft one sample answer to "Why do you want to work here?" for a made-up
   company and ask if it sounds like them. Adjust `data/voice.local.md` and
   the `facts` list until it does. The local file is git-ignored and is the
   one the tool uses.
5. Copy `data/bank.example.json` to `data/bank.json` and rewrite each draft
   with the user's own facts. These are the starting points for the common
   open questions.
6. Fill `answers` in the profile: how the user wants recurring questions
   answered (which engineering area, relocation, notice period, text-message
   consent, a posting that asks for another graduation date). JEV and Claude
   both follow them.
7. Remind them: anything not in `facts`, `experience`, `projects` or
   `answers` will never appear in an application.
