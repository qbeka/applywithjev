# documents/

Your files. Everything in this folder except this README is git-ignored.

| What | Where |
|---|---|
| The resume you want sent | `documents/resume.pdf` (`resume.path` in `data/profile.json` points here) |
| A transcript, for forms that ask for one | `documents/transcript.pdf` (`transcript.path` in the profile) |
| A resume and a cover letter written for one job | `documents/tailored/<Company>_<Role>_<job id>/`: `resume.pdf`, `resume.md`, `cover.pdf`, `tailored.json` |

| Your own resume and cover letter design | `documents/templates/<name>/resume.html` and `cover.html`, registered with `npx jev templates --add <folder> --name <name>` |

`npx jev tailor <job id> --cover` writes the tailored pair. `npx jev apply
--tailor --cover` writes and attaches them as it applies. Every number and
every name in them is checked against your profile before the PDF is made.
