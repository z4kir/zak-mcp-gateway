---
trigger: always_on
description: Mandatory rule to always author documentation in HTML and export to PDF
---

# Documentation Standard: HTML & PDF Only

Whenever any project documentation, guide, roadmap, or specification is created or updated:

1. **Author in Clean HTML**:
   - Write structured, styled HTML5 documents.
   - Use clean typography (Inter / Roboto / system-ui), card layouts, badge chips, formatted tables, and inline SVG diagrams.
   - Include print CSS (`@media print`, `@page { size: A4; margin: 15mm; }`).

2. **Always Export to `.pdf`**:
   - Use headless Chrome/Edge to generate the PDF immediately:
     ```powershell
     & "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="<full-output-path.pdf>" "<full-input-path.html>"
     ```
   - Save both the `.html` and the corresponding `.pdf` in the `docs/` folder.
