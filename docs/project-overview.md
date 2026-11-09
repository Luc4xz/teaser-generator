# Teaser Studio: From a Research Paper to an Explainable Image

Teaser Studio now focuses on one task: upload a paper, describe what the image should communicate, and generate one or several illustrations. The desktop screen dedicates 40 percent of its width to the paper and request, and 60 percent to the display canvas. A horizontal workflow at the top shows upload, description, generation, and results. Chat history and the unrelated research sidebar have been removed from the active interface.

The input panel supports selectable-text PDFs, plain text, and Markdown, plus pasted paper text. Users can review extracted content, write a visual request, choose a palette, and request one to three images. No factor matrix or approval checklist is required. The user prompt is a communication instruction rather than a scientific claim that must itself appear in the paper.

When a paper is provided, the backend selects source passages and asks for a structured visual plan. It checks supporting quotations and the references connecting facts to visual elements. The image generator receives a drawing prompt built from that plan. Each resulting image has a “Why this image?” card showing the intended connection between a paper claim and its visual depiction. Supporting quotes, paper context, and the drawing prompt can be expanded for inspection.

These cards explain why the image was requested; they do not establish that the generated pixels correctly represent every claim. If source-backed planning cannot be completed, the system still attempts an image based on the user's direction and labels it as a creative interpretation. It does not invent source citations. Prompt-only generation is also supported.

Multiple images are generated sequentially and appear as each request completes. Users can switch between them, expand an image, and download it. If a later request fails, earlier images remain available. The current canvas and input are saved in browser storage where capacity permits. A new successful batch replaces the current canvas, so users should download outputs they want to keep.

The default backend remains Pollinations. Provider availability, refusals, and exhausted rate-limit retries can still prevent generation; the app reports these failures rather than pretending that an image exists. This version concentrates on the core paper-to-image workflow and on making the intended paper-image relationship inspectable.
