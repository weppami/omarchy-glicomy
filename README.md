# Glicomy for Omarchy

A blood-glucose log in your Omarchy bar. Log finger-stick readings for several people, see each reading's category against the ADA targets, switch between mg/dL and mmol/L, review trends and statistics, and export PDF or CSV reports. Everything stays on your machine; the plugin makes no network requests.

Glicomy is modelled on [omarchy-tensio](https://github.com/juancasanueva/omarchy-tensio), the blood-pressure plugin by Juan Casanueva, and reuses its storage, process and keyboard foundations.

## Quick path

1. Add the plugin and enable it in the bar:

   ```bash
   omarchy plugin add https://github.com/pgferro/omarchy-glicomy --enable
   ```

   Or add it first and enable it later, choosing a bar section:

   ```bash
   omarchy plugin add https://github.com/pgferro/omarchy-glicomy
   omarchy plugin enable io.github.pgferro.glicomy --section right
   ```

2. Click the drop in the bar, create a profile, and press **+** to log the first reading.
3. The bar now shows the active profile's last reading, coloured by its range.

## Features

| Area | What you get |
|------|--------------|
| Bar | Drop icon plus the active profile's last glucose value, coloured by its range. The tooltip adds the unit, range and how long ago it was taken. Click to open the panel. |
| Units | mg/dL or mmol/L, switched with `u` or the unit button in the header. Readings are stored in mg/dL, so switching never changes your data. |
| Profiles | Up to 20 profiles, each with its own readings. Add, rename, delete and switch from the header menu. |
| Records | Readings grouped by day, newest first (the 200 most recent are listed; CSV export holds the full log). Add, edit and delete readings. |
| Reading fields | Glucose, date, time, context (fasting, before or after a meal, bedtime, overnight, exercise, other), carbs in grams, insulin units, note (up to 200 characters). Carbs and insulin are optional. |
| Analysis | Glucose chart with the before-meal target band (80–130 mg/dL) and the after-meal limit (180 mg/dL), a summary (average, SD, CV, min–max, estimated A1C), and the share of readings in each range, over 7 days, 30 days or all readings. |
| Reports | Summary for the chosen range and export to PDF (in the current unit) or CSV (both units), with **Open** and **Open folder** buttons. |
| Info | Range table, hypoglycaemia and very-high warnings, sources and medical disclaimer (the **ⓘ** button in the header). |

Accepted values: glucose 20–600 mg/dL (1.1–33.3 mmol/L), carbs 0–500 g, insulin 0–100 units in steps of 0.1. Up to 20,000 readings in total.

## Glucose ranges

Each reading is judged against the American Diabetes Association (ADA) Standards of Care goals for most non-pregnant adults with diabetes: **80–130 mg/dL before meals** and **under 180 mg/dL 1–2 hours after a meal**. The reading's **Context** picks the table. *After meal* uses the after-meal goals; every other context, including none, uses the before-meal goals. A reading of 176 mg/dL is therefore **High** when fasting or untagged, and **In target** when tagged *After meal*.

| Range | Before meals (mg/dL) | Before meals (mmol/L) | After meals (mg/dL) | After meals (mmol/L) |
|-------|----------------------|-----------------------|---------------------|----------------------|
| Very low (level 2 hypo) | < 54 | < 3.0 | < 54 | < 3.0 |
| Low (level 1 hypo) | 54–69 | 3.0–3.8 | 54–69 | 3.0–3.8 |
| Below target | 70–79 | 3.9–4.4 | — | — |
| In target | 80–130 | 4.5–7.2 | 70–180 | 3.9–10.0 |
| High | 131–250 | 7.3–13.9 | 181–250 | 10.1–13.9 |
| Very high | > 250 | > 13.9 | > 250 | > 13.9 |

mmol/L values are converted with 1 mmol/L = 18.0182 mg/dL and rounded to one decimal. Ranges are classified in mg/dL, so the mmol/L column shows where each band starts after rounding: 80 mg/dL is 4.44 mmol/L, which is why a typed 4.4 counts as *Below target* and the target starts at 4.5.

The summary also shows:

- **SD and CV**: the spread of your readings. A CV at or below 36% is considered stable.
- **Est. A1C**: the ADAG estimate from the average, (mean mg/dL + 46.7) / 28.7. It is only a rough guide from finger-stick averages and needs many readings over several weeks. It is not a lab result.

Older or high-risk adults and pregnancy use different targets; your care team may set your own.

## Keyboard and IPC

Everything in the panel works without the mouse. Press `?` in the panel for the same list. Single-letter keys are ignored while a text field has focus, so typing a note never triggers a shortcut.

### Global

| Keys | Action |
|------|--------|
| `1` `2` `3` or `Left` / `Right` | Switch between Records, Analysis and Reports |
| `n` or `+` | New reading |
| `u` | Switch between mg/dL and mmol/L |
| `p` | Open the profile menu |
| `[` / `]` | Previous / next profile |
| `i` | Glucose ranges and safety information |
| `?` | Show or hide this shortcut list |
| `w` / `m` / `a` | Range 7 days / 30 days / all (Analysis and Reports) |
| `Esc` | Close the topmost layer, otherwise the panel |

### Records

| Keys | Action |
|------|--------|
| `j` / `k` or `Down` / `Up` | Select the next / previous reading |
| `g` / `G` or `Home` / `End` | Select the first / last reading |
| `PageUp` / `PageDown` | Move the selection by a page |
| `Enter` or `e` | Edit the selected reading |
| `x` or `Delete` | Delete the selected reading (asks first) |

### Analysis, info and help

| Keys | Action |
|------|--------|
| `j` / `k` or `Down` / `Up` | Scroll |
| `PageUp` / `PageDown` | Scroll by a page |

### Reports

| Keys | Action |
|------|--------|
| `e` | Export PDF |
| `c` | Export CSV |
| `o` | Open the last export |
| `f` | Open the folder of the last export |

### Profile menu

| Keys | Action |
|------|--------|
| `j` / `k` or `Down` / `Up` | Move through the menu |
| `Enter` | Select the highlighted profile or action |
| `a` / `r` / `d` | Add / rename / delete profile |
| `p` or `Esc` | Close the menu |

### Reading form

| Keys | Action |
|------|--------|
| `Tab` / `Shift+Tab` | Next / previous field |
| `Up` / `Down` or `PageUp` / `PageDown` | Adjust glucose, carbs or insulin by a small / large step |
| `Space` or `Enter` | Open a dropdown or press the focused button |
| `Ctrl+Enter` or `Ctrl+S` | Save from any field |
| `Esc` | Cancel |

### Dialogs

| Keys | Action |
|------|--------|
| `Enter` or `y` | Confirm (Left / Right picks the button Enter presses) |
| `Esc` or `n` | Cancel a confirmation |
| `Enter` / `Esc` | Save / cancel a profile name |

Keyboard focus is always visible: the selected reading and the highlighted menu row get an accent border, and form fields and buttons show the focus ring. In the reading form, `Up` / `Down` step glucose by 1 mg/dL or 0.1 mmol/L, carbs by 1 g and insulin by 0.5 units; `PageUp` / `PageDown` step by 10 mg/dL, 1 mmol/L, 10 g or 5 units.

Toggle the panel from a keybinding or script:

```bash
omarchy-shell shell toggle io.github.pgferro.glicomy
```

To bind it in Omarchy, add a line like this to `~/.config/hypr/bindings.lua` (pick a key combination that is still free on your system); Glicomy never edits that file itself:

```lua
o.bind("SUPER + CTRL + ALT + G", "Glicomy", "omarchy-shell shell toggle io.github.pgferro.glicomy")
```

## Privacy and files

> **No network access.** Glicomy opens no sockets, fetches no URLs and loads no remote images. Every text item renders as plain text, so stored names and notes are never interpreted as markup.

| What | Where | Permissions |
|------|-------|-------------|
| State (profiles, readings and the display unit) | `$XDG_STATE_HOME/glicomy/state.json`, default `~/.local/state/glicomy/state.json` | File `0600` in a `0700` directory |
| Exports | `<Documents>/Glicomy/Glicomy-<profile>-<YYYYMMDD-HHMM>.pdf` or `.csv` | Files `0600`; a newly created `Glicomy` folder is `0700` |

- **Documents folder**: `$XDG_DOCUMENTS_DIR`, then `XDG_DOCUMENTS_DIR` from `~/.config/user-dirs.dirs`, then `~/Documents` if it exists, otherwise your home directory.
- **Exports never overwrite**: a second export in the same minute gets a `-2`, `-3`, … suffix. An export that fails while writing is removed.
- **State writes are atomic**: a temporary file in the state directory is renamed over `state.json`. The state file is capped at 4 MiB and validated on every load and save; a state file Glicomy cannot read is reported and never overwritten.
- **Symlinks are refused** for the state directory, the state file and the `Glicomy` export folder.
- **CSV cells** that start with `=`, `+`, `-` or `@` are prefixed with `'` so spreadsheets do not run them as formulas.

The plugin starts only these processes, always as argument lists without a shell:

| Process | When |
|---------|------|
| `/usr/bin/python3 -I -S <plugin>/bin/glicomy_store.py load\|save\|export` | Loading, saving and exporting. Runs with a cleared environment (only `HOME`, the `XDG_*` locations, a fixed `PATH` and `LANG`), a deadline and bounded output. |
| `/usr/bin/xdg-open <file>` or `<folder>` | Only when you press **Open** or **Open folder** for the file the plugin just exported. |

## Removing

```bash
omarchy plugin remove io.github.pgferro.glicomy
```

This disables the widget and deletes the plugin folder (`~/.config/omarchy/plugins/io.github.pgferro.glicomy`). Your data is kept:

| Survives removal | How to delete it manually |
|------------------|---------------------------|
| `~/.local/state/glicomy/state.json` (or under `$XDG_STATE_HOME`) | `rm ~/.local/state/glicomy/state.json` then `rmdir ~/.local/state/glicomy` |
| Exported reports in `<Documents>/Glicomy/` | Delete the reports you no longer need from a file manager, then `rmdir` the empty folder |

Glicomy installs no services, timers, hooks or packages, so nothing else remains.

## Development

Requirements: Omarchy 4 shell (Quickshell), `/usr/bin/python3` (standard library only), Node.js for the model tests.

```bash
node tests/test_model.cjs                       # domain model (ranges, units, stats, validation, keymap)
/usr/bin/python3 -m unittest discover -s tests  # store helper and PDF writer
omarchy plugin validate .                       # manifest schema check
```

| Path | Role |
|------|------|
| `Panel.qml` | Bar button, panel, state and helper calls |
| `components/` | Pages, charts, form and dialogs |
| `Model.js` | Pure domain logic shared by the panel and the tests |
| `bin/glicomy_store.py` | Load, save and export helper |
| `bin/glicomy_pdf.py` | Dependency-free PDF report writer |

## Medical disclaimer

Glicomy does not measure glucose and is not a medical device. Never change insulin or medication doses based on this app alone; always check with your doctor before making medical decisions.

If a reading is low (below 70 mg/dL or 3.9 mmol/L), treat it with 15 g of fast-acting carbohydrate and recheck in 15 minutes. If someone is confused, unconscious or cannot swallow, call emergency services. Very high readings with nausea, vomiting, abdominal pain, fast breathing or fruity breath can mean diabetic ketoacidosis: check ketones if you can and seek urgent care.

## License

MIT. See [LICENSE](LICENSE). Portions are derived from omarchy-tensio, © 2026 Juan Casanueva, under the MIT license.
