# applications/

Your records, one CSV each. Everything in this folder except this README
and `example.csv` is git-ignored, so none of it can be committed by
accident.

| File | What it holds | How to read it |
|---|---|---|
| `applied.csv` | One row per application you sent, newest first | `npx jev log`, or `log --open` for your spreadsheet program |
| `manual.csv` | The jobs the tool opened and could not finish, with the reason and the link | `npx jev log --manual` |
| `takehome.csv` | Applications sent to a company that also wants a take-home assignment, with its link | open the file |
| `all.csv` | Every job considered, including the ones skipped, with the reason. Its first 15 columns match a common job-tracking sheet | `npx jev log --all` |
| `example.csv` | The shape of `all.csv`, with no personal data, for tests | |

The column names never change, so a script can rely on them. The columns of
`applied.csv` are listed in the main README under "Find your applications".
`log --json` prints the same rows as JSON.
