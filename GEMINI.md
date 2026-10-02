# Project Rules: ZAK MCP Gateway

## Rule: Documentation Generation Standard (HTML & PDF)

1. **Format Requirement**:
   - Always author project documentation, specifications, reports, and architecture guides in clean, styled HTML and export them as **`.pdf`** files.
   - Do not rely solely on raw Markdown for formal project documentation.

2. **Styling & Layout Guidelines**:
   - Write semantic HTML5 with modern CSS styling (clean typography, subtle borders, card containers, code blocks, tables, and badge chips).
   - Ensure print-friendly formatting:
     ```css
     @media print {
       body { margin: 0; padding: 15mm; font-size: 11pt; color: #111; }
       .page-break { page-break-before: always; }
       @page { size: A4; margin: 15mm; }
     }
     ```
   - For diagrams, render visual HTML/SVG cards or embedded SVG flowcharts so they render with 100% fidelity in PDF export.

3. **PDF Generation Command**:
   - Automatically compile the HTML into `.pdf` using headless Chrome/Edge:
     ```powershell
     & "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf="<full-path-to-pdf>" "<full-path-to-html>"
     ```
   - Store both `<document-name>.html` and `<document-name>.pdf` inside the `docs/` folder.
