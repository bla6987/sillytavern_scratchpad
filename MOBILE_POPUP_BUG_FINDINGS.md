# Mobile Quick Popup Bug Report

## Issue Summary

On mobile viewports, the Scratch Pad quick popup appears at the **top** of the screen instead of the bottom, and the response content is not visible. Users see only the action buttons ("Open in Scratch Pad" and "Dismiss") at the very top edge of the viewport.

## Root Cause Analysis

### The Problem

The `.sp-popup` container has a computed height of **0px** on mobile devices, causing the flexbox alignment to invert the popup's position.

### Technical Details

1. **CSS Structure**: The popup uses the following positioning:
   ```css
   .sp-popup {
       position: fixed;
       top: 0;
       left: 0;
       right: 0;
       bottom: 0;
       display: flex;
       flex-direction: column;
       justify-content: flex-end;  /* ← This is key */
   }
   ```

2. **Expected Behavior**: With `position: fixed` and `inset: 0`, the container should fill the entire viewport. The `justify-content: flex-end` would then push the `.sp-popup-sheet` child to the bottom of the screen.

3. **Actual Behavior on Mobile**: The `.sp-popup` container's height collapses to **0px**. Because the container has no height but still uses `justify-content: flex-end`, the child sheet aligns its bottom edge to the container's bottom (which is at `top: 0` of the viewport). This results in:
   - The popup sheet rendering at negative Y-coordinates (above the visible viewport)
   - Only the bottom portion (action buttons) appearing at the top of the screen
   - The response content being hidden above the top edge of the browser

### Why Height Collapses to 0px

The likely causes are:

1. **SillyTavern's CSS interference** - SillyTavern or another extension may have CSS rules that override or conflict with the fixed positioning. Common culprits:
   - A parent element with `overflow: hidden` and conflicting positioning
   - CSS rules that set `height: 0` on fixed-position elements
   - Transform or filter properties on parent elements that create new stacking contexts

2. **Mobile browser quirks** - Some mobile browsers handle `position: fixed` differently, especially when:
   - Virtual keyboards are present
   - The URL bar is visible/hidden
   - Parent elements have `transform` properties

3. **Dynamic viewport height** - Mobile browsers have variable viewport heights due to browser chrome. Using `100vh` can cause issues because it represents the "large viewport" height, not the actual visible area.

## Evidence

### Observations from Testing

- The `/sp` command executes successfully (no JavaScript errors)
- The AI response is generated and correctly inserted into the DOM
- The `.sp-popup-content` div contains the full response HTML
- The popup container (`#scratch-pad-popup`) is present in the DOM
- The issue is purely a **CSS layout problem**, not a JavaScript/rendering issue

### Computed Styles Captured

```javascript
// Popup container
{
  position: "fixed",
  top: "0px",
  bottom: "0px",
  height: "0px",           // ← THE BUG
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-end"
}
```

## Recommended Fixes

### Option 1: Explicit Height (Recommended)

Add explicit height declarations with `!important` to override any conflicting styles:

```css
.sp-popup {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    height: 100vh !important;
    height: 100dvh !important;  /* Dynamic viewport height for mobile */
    min-height: 100vh !important;
    min-height: 100dvh !important;
}
```

### Option 2: Use Inset with Height Fallback

```css
.sp-popup {
    position: fixed;
    inset: 0;
    width: 100vw;
    width: 100dvw;
    height: 100vh;
    height: 100dvh;
}
```

### Option 3: Alternative Layout Approach

Instead of relying on `justify-content: flex-end`, position the sheet absolutely at the bottom:

```css
.sp-popup {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
}

.sp-popup-sheet {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    max-height: 70vh;
    max-height: 70dvh;
}
```

### Option 4: Check for Conflicting Parent Styles

Look for and remove/override any SillyTavern styles that might be affecting the popup container, such as:
- Parent elements with `transform` or `filter`
- Container elements with `overflow: hidden`
- Other fixed-position overlays that might interfere

## Files Involved

| File | Description |
|------|-------------|
| `src/ui/popup.js` | Creates the popup DOM structure |
| `style.css` | Contains all popup styling (lines 669-818) |

## Verification Steps

After applying a fix:

1. Open SillyTavern on a mobile viewport (400px × 800px or similar)
2. Open an existing chat
3. Type `/sp What is the meaning of life?` and submit
4. Verify:
   - [ ] Popup appears as a bottom sheet (action buttons at the bottom)
   - [ ] The response text is visible in the content area
   - [ ] The backdrop covers the full screen
   - [ ] Swipe-to-dismiss gesture works correctly
   - [ ] "Dismiss" and "Open in Scratch Pad" buttons are functional

## Recording

A video recording of the bug reproduction is available at:
![mobile_popup_test_1768239730034.webp](/home/pop/.gemini/antigravity/brain/2b4e9b64-3def-4458-a330-c6ed6927956d/mobile_popup_test_1768239730034.webp)
