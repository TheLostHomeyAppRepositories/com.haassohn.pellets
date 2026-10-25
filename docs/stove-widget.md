# Pellet stove dashboard widget

Add **Pellet stove** to a Homey dashboard and select a paired stove in the widget
settings. The compact widget supports Homey's light and dark themes and all 13
Homey languages: English, Dutch, German, French, Italian, Swedish, Norwegian,
Spanish, Danish, Russian, Polish, Korean and Arabic. Arabic uses a mirrored layout;
numbers, units, settings labels, control labels and errors are localized.

- The square power button has a centered localized On/Off label and sends an
  explicit on/off request using the existing stove control.
- Current temperature is reported by the stove in °C. Tap the target temperature
  to open its editor, adjust the number field or −/+ buttons, then press **Apply**.
  **Cancel** or Escape closes the editor without sending a command. The main target
  reading always shows reported state, including while an unsaved draft is open.
  The device's
  supported range and step apply (normally 5–35 °C, in steps of 1 °C). The target
  cannot be changed while the stove's weekly program is active.
- The operating mode comes from `stove_mode`. Known modes use localized labels;
  unknown controller text is preserved. Existing power and heating/standby
  capabilities provide a fallback when no mode is available. Regular cleaning is
  part of the status, for example **Heating, Cleaning in 12h** or **Off, Cleaning
  required**. The existing `measure_stove_cleaning_in` value is already in hours;
  zero or negative means cleaning is required. A missing value is shown as unknown,
  and an unavailable stove does not display a stale cleaning countdown. This is
  separate from the long-term maintenance/ash limit. An error panel shows
  the reported error code; expand it for the same possible causes used by the app.
- Remaining pellets are the app's consumption-based **estimate**, not a measured
  hopper level. **Half full** and **Full** set that estimate to an absolute amount;
  they do not add bags or send a refill command to the stove. Defaults are 15 kg
  and 30 kg. Configure each amount independently in the widget settings, using
  whole kilograms. For example, use 12 kg / 24 kg to match your experience.
- Reset amounts must fit within the stove device's **Pellets capacity (kg)**
  setting. A reset above capacity is rejected with an explanation rather than
  silently reduced. The widget does not change the device capacity or its existing
  automatic pellet-reset behavior.
- Subtle flames animate behind the pellet watermark while Homey reports the stove
  available, on and heating without an error. They pause when the widget is hidden
  or the stove is off, unavailable or in error. Reduced-motion preferences disable
  animation. Pellet resets update the reading without a success-message footer.

The widget reads Homey's cached capabilities every 10 seconds while visible. It
does not poll the physical stove separately. The existing device polling interval
determines how quickly stove changes reach Homey. While a command is pending,
controls are disabled; duplicate commands from other instances of this widget are
also rejected. Reported state is displayed after a command, without assuming it
has already taken effect. An unavailable stove disables controls and hides current
temperature readings; the local pellet estimate and last reported error remain
visible. A failed widget API read clears readings until a fresh read succeeds.

The photo and SVGs under `widgets/stove/public/images/` reuse existing assets.
The compact photo is an unchanged copy of `assets/images/small.png`; the pellets,
flame and error graphics come from the existing icons (including `ignitions.svg`).
They are copied into the public directory because widget-relative assets are
hosted there. Picker previews are simplified, language-neutral illustrations of
the widget's layout, with placeholder bars instead of text or readings. They do
not contain photos or screenshots. Editable sources are `preview-light.svg` and
`preview-dark.svg` beside their corresponding 512×512 PNGs. Render those SVGs to
PNG when updating the picker previews; keep live-UI screenshots separate.

## Local verification

```text
npm run build
node --check widgets/stove/api.js
node --check widgets/stove/public/widget.js
npm run lint
homey app validate
homey app validate --level publish
node --test tests/stove-widget.test.cjs
git diff --check
```

The current repository ESLint configuration cannot parse the existing TypeScript
files. The widget JavaScript can be checked separately with
`npx --no-install eslint widgets/stove/api.js widgets/stove/public/widget.js`.
Browser scripts are excluded from TypeScript compilation so CommonJS wrappers are
not injected into the widget's public JavaScript. Homey's build copies public
assets unchanged.
Run the checks sequentially: Homey validation recreates `.homeybuild/`, and the
tests inspect that generated package as well as the source.

The optional browser check verifies all 13 languages, both themes, three widths,
square centered power labels, modal editing, command payloads, cleaning, errors,
weekly scheduling and reduced motion using an illustrative local API. It does not
contact Homey or a physical stove. Use an existing external `playwright-core`
installation (it is not an app dependency), for example in PowerShell:

```powershell
$env:PLAYWRIGHT_MODULE_PATH = "$env:TEMP\haassohn-widget-tools\node_modules\playwright-core"
node tests/stove-widget-browser.cjs
```

The check uses installed Chrome by default. Set `BROWSER_EXECUTABLE` to another
compatible Chromium executable if needed. This check does not generate or
overwrite picker previews. The former `--previews` screenshot option is rejected.

## Homey smoke test (requires installation and real-device authorization)

1. Install a test build, verify app/driver initialization, and add the widget.
   Select an existing paired stove; verify its name, mode, power state, both
   temperatures and pellet estimate against Homey's device view.
2. Check light/dark themes, narrow and wide dashboards, a long device name, a
   language with longer labels and Arabic RTL. Verify the square power label,
   target editor focus, Cancel/Escape and unchanged reported target while editing.
   Expand an existing reported error and compare its code and possible causes
   against the device warning. Do not deliberately create a stove fault.
3. Turn the stove on and off when safe. Verify the physical controller and the
   widget agree after the normal stove transition and polling interval.
4. Set a supported target temperature and verify the stove reports it back.
   Enable the weekly program and verify widget temperature editing is disabled.
5. Configure custom reset amounts within capacity. Press each button and verify
   the corresponding absolute estimate in the widget, device capabilities and
   device settings. Restart the app and verify the estimate persists.
6. Configure a reset above capacity and verify the explanatory error without a
   changed estimate. Restore the intended setting afterwards.
7. Check an unavailable device and recovery; confirm controls disable and readings
   return after connectivity recovers. Verify rapid taps do not duplicate requests
   and reopening the dashboard resumes updates.
8. Compare the combined status/regular-cleaning countdown with the device view.
   If it is already at zero, confirm **Cleaning required** without deliberately
   creating a fault. Check unknown readings and offline recovery when available.
   Verify subtle flames appear only with the reported heating state and stop with
   reduced motion enabled. No pellet-reset success footer should appear.

Local builds, tests, browser previews and Homey validation do not prove these
Homey or physical-stove scenarios.
