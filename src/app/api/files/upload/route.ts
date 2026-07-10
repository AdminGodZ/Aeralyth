export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StreamingRequestInit = RequestInit & {
  duplex: "half";
};

const REQUEST_HEADERS = [
  "content-length",
  "content-type",
  "cookie",
  "x-csrf-token",
] as const;

const RESPONSE_HEADERS = [
  "cache-control",
  "content-disposition",
  "content-type",
  "location",
] as const;

export async function POST(request: Request) {
  if (!request.body) {
    return Response.json({ error: "upload body required" }, { status: 400 });
  }

  const apiOrigin =
    process.env.AERALYTH_API_ORIGIN?.trim() || "http://127.0.0.1:8080";
  const target = new URL("/api/files/upload", apiOrigin);
  target.search = new URL(request.url).search;
  const headers = new Headers();

  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);

    if (value) {
      headers.set(name, value);
    }
  }

  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers,
      body: request.body,
      redirect: "manual",
      signal: request.signal,
      duplex: "half",
    } as StreamingRequestInit);
    const responseHeaders = new Headers();

    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);

      if (value) {
        responseHeaders.set(name, value);
      }
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }

    console.error("Upload streaming proxy failed", error);
    return Response.json(
      { error: "upload backend unavailable" },
      { status: 502 },
    );
  }
}
