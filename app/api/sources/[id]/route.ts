/**
 * GET /api/sources/:id — cited passage in context (DESIGN.md §13).
 * Resolves a chunk id (content-addressed, e.g. "income-tax-act-2015-act-896:a1b2c3d4:7")
 * to the passage text plus document metadata for the citation card.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { chunks, documents } from "@/db/schema";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const [row] = await db
    .select({
      chunkId: chunks.id,
      sectionPath: chunks.sectionPath,
      text: chunks.text,
      pageNumber: chunks.pageNumber,
      supersededAt: chunks.supersededAt,
      documentId: documents.id,
      documentTitle: documents.title,
      publisher: documents.publisher,
      publishedAt: documents.publishedAt,
      sourceUrl: documents.sourceUrl,
    })
    .from(chunks)
    .innerJoin(documents, eq(chunks.documentId, documents.id))
    .where(eq(chunks.id, id))
    .limit(1);

  if (!row) {
    return Response.json({ error: "source not found" }, { status: 404 });
  }
  return Response.json(row);
}
