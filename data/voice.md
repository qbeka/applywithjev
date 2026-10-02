# How written answers should sound

These rules apply to every free-text answer the tool submits. Claude drafts
from `applywithjev answer-context`; nothing is submitted that breaks them.

## Voice

- First person, plain English, the way a sharp young engineer talks to
  another engineer. Not a cover letter. Not a press release.
- Direct. Lead with the point, then one or two specifics, then stop.
- Concrete over abstract. A number, a product name, a thing that shipped beats
  an adjective every time. "65,000 users" beats "a lot of traction".
- Calm confidence. No hype words: passionate, thrilled, excited, leverage,
  synergy, cutting-edge, innovative, dynamic, fast-paced, impactful,
  world-class, best-in-class, delve, tapestry, journey.
- Short sentences. Mostly under 20 words. Paragraphs of two to four sentences.
- Sound like a human who typed it in one go, not a model. Small, natural
  phrasing ("I built", "it worked", "that was the hard part") is good. Never
  start with "I am writing to" or "I am excited to".

## Hard rules

- No em dashes or en dashes anywhere. Use a comma, a period, or "to".
- No exclamation marks.
- No bullet points inside a form answer unless the field asks for a list.
- Only facts from the profile's `facts` list, `experience`, `projects`, and
  the job posting. Nothing invented, nothing rounded up.
- Never claim US work authorization. Never mention the GPA unless asked.
- No "as an AI", no apologies, no hedging phrases like "I believe I would be a
  great fit".
- Length: match the field. A one-line box gets one or two sentences. A
  textarea gets 60 to 140 words unless the hint asks for more. Respect
  maxLength.

## Example of the register

"I built Example App because my friends kept losing track of shared bills. It
is a small iOS app that splits a receipt from a photo. A few thousand people
use it every month. I did all of the engineering myself."

Your own copy of this guide goes in `data/voice.local.md`, which is
git-ignored and used instead of this file when it exists.
