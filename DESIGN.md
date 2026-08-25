---
version: "1.0"
name: Bentway-Precision-Operations
description: >-
  A calm, product-first design system combining the shared strengths of Apple
  and Supabase: near-black typography, white and soft-neutral surfaces,
  restrained color, generous spacing, tight display typography, subtle
  hairlines, and product interfaces as the primary visual language. Built for
  a logistics operations application rather than as a copy of either brand.

colors:
  primary: "#0071e3"
  primary-hover: "#0066cc"
  primary-soft: "#e8f2ff"
  on-primary: "#ffffff"
  ink: "#1d1d1f"
  ink-secondary: "#333336"
  ink-muted: "#707070"
  ink-faint: "#9a9a9a"
  canvas: "#ffffff"
  canvas-soft: "#f5f5f7"
  surface: "#fafafa"
  surface-dark: "#1c1c1c"
  surface-dark-soft: "#252527"
  on-dark: "#ffffff"
  hairline: "#dfdfdf"
  hairline-soft: "#ededed"
  success: "#24b47e"
  success-soft: "#e7f7f0"
  warning: "#b35c00"
  warning-soft: "#fff4e5"
  danger: "#d92d20"
  danger-soft: "#fff0ef"

typography:
  display-xl:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: -1.2px
  display-lg:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: -0.72px
  heading-lg:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.42px
  heading-md:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: -0.2px
  heading-sm:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: -0.1px
  body-lg:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: -0.1px
  body:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  body-strong:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: 0
  button:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0
  caption:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  micro:
    fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0

rounded:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  full: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 48px
  huge: 64px
  section: 80px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "12px 18px"
    minHeight: 44px
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "12px 18px"
    minHeight: 44px
  icon-button:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.sm}"
    size: 44px
  text-input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
    minHeight: 44px
  card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  card-dark:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.on-dark}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  status-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "4px 8px"
  status-warning:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.warning}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "4px 8px"
  status-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "4px 8px"
  data-table:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline-soft}"
    headerBackground: "{colors.surface}"
    headerTypography: "{typography.micro}"
    bodyTypography: "{typography.body}"
    cellPadding: "12px 16px"
  code-block:
    backgroundColor: "{colors.surface-dark}"
    textColor: "{colors.on-dark}"
    typography: "{typography.code}"
    rounded: "{rounded.sm}"
    padding: "{spacing.md}"
  app-header:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline-soft}"
    typography: "{typography.body}"
    height: 64px
    padding: "0 {spacing.lg}"
  sidebar-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    activeBackground: "{colors.primary-soft}"
    activeTextColor: "{colors.primary-hover}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
    minHeight: 44px
---

# Overview

This system combines the compatible foundations of Apple and Supabase without
copying either brand. It is quiet, precise, and product-first. The application
interface, delivery map, operational tables, and workflow states are the visual
focus; decorative chrome stays secondary.

The default surface is white with near-black text. Soft off-white bands separate
major regions. Blue is the only action color. Green is semantic success only,
not a competing brand accent. Warning and danger colors appear only when their
meaning is required.

## Core Principles

- Let operational content carry the interface: maps, tables, shipment details,
  timelines, and system state are more important than decoration.
- Use white and soft-neutral surfaces with near-black type and thin hairlines.
- Keep one clear primary action per view whenever possible.
- Use generous page spacing and compact, consistent component interiors.
- Use gradients only when they encode data. Never use decorative gradients.
- Prefer surface changes and hairlines over shadows.
- Use proprietary brand assets only when the project owns or licenses them.

# Color Rules

## Action and Status

- `{colors.primary}` is reserved for links, focus rings, selected navigation,
  and primary buttons.
- `{colors.success}` is reserved for confirmed, completed, healthy, or paid
  states. Do not use green for a generic primary CTA.
- `{colors.warning}` indicates delayed, pending, or attention-needed states.
- `{colors.danger}` indicates failed, destructive, blocked, or overdue states.
- Never rely on color alone: pair every state color with text and, where useful,
  an icon.

## Surfaces

- `{colors.canvas}` is the main page, card, form, and table surface.
- `{colors.canvas-soft}` separates page regions and supports dense utility areas.
- `{colors.surface}` is for table headers, filters, and quiet inset areas.
- `{colors.surface-dark}` is limited to code, high-contrast previews, or one
  deliberately inverted feature area.
- Do not create multiple nearly identical gray backgrounds beyond these tokens.

# Typography

- Use the system stack by default; use Inter only if it is already available.
- Display and headings use weight 600 with slightly negative letter-spacing.
- Body copy uses weight 400. Emphasis uses weight 600.
- Avoid weight 700 or heavier unless required for an existing brand asset.
- Use monospace only for code, identifiers, tracking numbers, or technical data.
- Keep body text at 16px minimum and use `{typography.body-lg}` for longer
  explanatory passages.

# Layout

## Grid and Containers

- Maximum application width: 1440px, centered on wide screens.
- Maximum reading width: 720px for long-form help or instructions.
- Desktop app shell: 240–280px sidebar plus flexible main content.
- Main content gutter: 24px desktop, 16px tablet, 12px mobile.
- Dashboard grids: 4 columns wide desktop, 2 columns tablet, 1 column mobile.
- Tables may scroll horizontally on small screens; never shrink text below 13px.

## Spacing Rhythm

- Major page sections use 48–80px vertical separation.
- Page headings use 24–32px space below them.
- Cards use 24px padding on desktop and 16px on mobile.
- Related controls use 8–12px gaps; unrelated groups use 24–32px gaps.
- Avoid filling whitespace with decorative content.

# Components

## Buttons

- Primary buttons use `{components.button-primary}` and appear once per action
  cluster.
- Secondary buttons use a white surface and 1px hairline border.
- Buttons use 8px radius. Full pills are reserved for status tags and avatars.
- Hover may darken the primary color; pressed state may use
  `transform: scale(0.98)`.
- Focus uses a visible 2px `{colors.primary}` outline with a 2px offset.
- Destructive actions must use explicit danger styling and confirmation when
  data loss is possible.

## Cards

- Default cards use a 1px hairline, 12px radius, and no drop shadow.
- Use shadow only for floating menus, dialogs, and composited product previews.
- Do not nest more than one card surface inside another.
- Dark cards are exceptional and should remain code- or data-focused.

## Forms

- Inputs are at least 44px high with visible labels; placeholders are examples,
  not label replacements.
- Error text appears next to the affected field and explains how to recover.
- Required, disabled, read-only, and invalid states must be visually distinct.
- Keep related label, input, helper, and error text in one vertical group.

## Tables and Operational Data

- Keep table headers quiet with a soft surface and medium-weight labels.
- Align numbers right and text left; use tabular numerals where available.
- Keep shipment IDs, dates, quantities, money, and statuses scannable.
- Sticky headers are allowed for long tables.
- Row actions should be visible on focus as well as hover.

## Navigation

- Use a white 64px top bar with a subtle bottom hairline.
- Active sidebar rows use the soft blue selection surface, not a filled blue bar.
- Preserve labels beside icons unless space is genuinely constrained.
- On mobile, replace the sidebar with a drawer and keep the current page title
  visible.

# Product Visuals

- Use real application views, delivery maps, shipment tables, and workflow
  diagrams as the primary imagery.
- Prefer one clear product screenshot over decorative stock photography.
- Product previews may use a 12px radius and a subtle
  `0 8px 24px rgba(0, 0, 0, 0.08)` shadow.
- Never apply heavy shadows to ordinary UI cards, buttons, or text.
- Do not use Apple or Supabase logos, wordmarks, screenshots, or marketing copy.

# Responsive Behavior

| Breakpoint | Width | Behavior |
|---|---:|---|
| Wide | ≥ 1440px | Content locks at 1440px; four-column dashboard grids |
| Desktop | 1024–1439px | Full sidebar; two- to four-column content grids |
| Tablet | 768–1023px | Compact sidebar or drawer; two-column grids |
| Mobile | < 768px | Drawer navigation; one-column layout; horizontal table scroll |
| Small mobile | < 480px | 12px gutters; headings step down; actions may stack full width |

- Touch targets must be at least 44×44px.
- Preserve map and chart meaning when labels collapse.
- Keep the primary action visible without covering important content.
- Use responsive images and load the above-the-fold visual eagerly; lazy-load
  off-screen imagery.

# Accessibility

- Meet WCAG AA contrast for text and interactive states.
- All functionality must work with a keyboard.
- Every input has a programmatic label and every icon-only control has an
  accessible name.
- Focus indicators must remain visible on light and dark surfaces.
- Respect reduced-motion preferences.
- Do not convey shipment or billing status by color alone.

# Do and Don't

## Do

- Use a restrained near-black, white, and soft-gray foundation.
- Use blue consistently for actions and green consistently for success.
- Use tight display type, generous outer spacing, and compact component spacing.
- Reuse existing project components and tokens before adding new ones.
- Preserve existing workflows, business logic, and data density.

## Don't

- Don't mix Apple pill CTAs with Supabase square buttons; use the defined 8px
  button radius consistently.
- Don't use blue and green as competing primary CTAs in the same view.
- Don't add decorative gradients, glassmorphism, or heavy card shadows.
- Don't copy either source brand's logo, product imagery, or wording.
- Don't redesign unrelated screens while implementing one requested view.

# Implementation Guide for Coding Agents

1. Read this entire file before changing UI code.
2. Audit existing tokens and components; reuse them where they satisfy this file.
3. Map these tokens into the project's existing CSS variables or theme system.
4. Implement the smallest requested surface first; do not rewrite business logic.
5. Check desktop at 1440px and mobile at 390px.
6. Run the project's existing tests and verify keyboard and focus behavior.
7. Report any deliberate deviation from this file and the reason.
