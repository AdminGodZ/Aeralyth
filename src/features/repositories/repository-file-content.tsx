"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useEffect, useMemo, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { RepositoryArchivePreview } from "@/features/repositories/repository-archive-preview";
import type { PreparedRepositoryFile } from "@/features/repositories/repository-file-loader";
import { RepositorySyntaxPreview } from "@/features/repositories/repository-syntax-preview";

const RepositoryMarkdownPreview = dynamic(
  () =>
    import("@/features/repositories/repository-markdown-preview").then(
      (module) => module.RepositoryMarkdownPreview,
    ),
  {
    loading: () => (
      <div className="space-y-4 px-8 py-7">
        <Skeleton className="h-8 w-2/5" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-32 w-full" />
      </div>
    ),
    ssr: false,
  },
);

export type ReadyRepositoryFile = PreparedRepositoryFile & {
  objectUrl: string;
  rawObjectUrl: string;
};

export function RepositoryFileContent({
  file,
  markdownMode,
  wrap,
}: {
  file: ReadyRepositoryFile;
  markdownMode: "preview" | "source";
  wrap: boolean;
}) {
  if (file.presentation.kind === "markdown" && markdownMode === "preview") {
    return <RepositoryMarkdownPreview markdown={file.text ?? ""} />;
  }
  if (
    (file.presentation.kind === "text" ||
      file.presentation.kind === "markdown") &&
    file.text !== null
  ) {
    return (
      <RepositorySyntaxPreview
        code={file.text}
        language={file.presentation.language ?? "text"}
        wrap={wrap}
      />
    );
  }
  if (file.presentation.kind === "image") {
    return (
      <RepositoryImagePreview
        name={file.name}
        objectUrl={file.objectUrl}
        hex={file.hex}
      />
    );
  }
  if (file.presentation.kind === "audio") {
    return (
      <div className="flex min-h-72 items-center justify-center bg-muted/15 p-8">
        {/* biome-ignore lint/a11y/useMediaCaption: arbitrary repository audio does not include a separate transcript track */}
        <audio
          controls
          preload="metadata"
          src={file.objectUrl}
          className="w-full max-w-2xl"
          aria-label={`Audio preview of ${file.name}`}
        />
      </div>
    );
  }
  if (file.presentation.kind === "video") {
    return (
      <div className="flex min-h-96 items-center justify-center bg-black p-4">
        {/* biome-ignore lint/a11y/useMediaCaption: arbitrary repository videos do not include a separate captions file */}
        <video
          controls
          preload="metadata"
          src={file.objectUrl}
          className="max-h-[70vh] max-w-full"
          aria-label={`Video preview of ${file.name}`}
        />
      </div>
    );
  }
  if (file.presentation.kind === "pdf") {
    return (
      <iframe
        src={file.objectUrl}
        title={`PDF preview of ${file.name}`}
        sandbox="allow-downloads"
        className="h-[70vh] min-h-[34rem] w-full bg-white"
      />
    );
  }
  if (file.presentation.kind === "archive") {
    return <RepositoryArchivePreview blob={file.blob} />;
  }
  if (file.presentation.kind === "font") {
    return (
      <RepositoryFontPreview
        fileId={file.objectUrl}
        name={file.name}
        objectUrl={file.objectUrl}
      />
    );
  }

  return <RepositoryBinaryPreview hex={file.hex} />;
}

function RepositoryImagePreview({
  name,
  objectUrl,
  hex,
}: {
  name: string;
  objectUrl: string;
  hex: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div>
        <p className="border-b bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          This browser cannot decode the image format. Its binary header is
          shown below.
        </p>
        <RepositoryBinaryPreview hex={hex} />
      </div>
    );
  }
  return (
    <div className="relative min-h-[34rem] bg-[linear-gradient(45deg,var(--muted)_25%,transparent_25%),linear-gradient(-45deg,var(--muted)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--muted)_75%),linear-gradient(-45deg,transparent_75%,var(--muted)_75%)] bg-[length:24px_24px] bg-[position:0_0,0_12px,12px_-12px,-12px_0]">
      <Image
        src={objectUrl}
        alt={`Preview of ${name}`}
        fill
        unoptimized
        sizes="(max-width: 1024px) 100vw, 70vw"
        className="object-contain p-5"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function RepositoryFontPreview({
  fileId,
  name,
  objectUrl,
}: {
  fileId: string;
  name: string;
  objectUrl: string;
}) {
  const family = useMemo(
    () => `AeralythPreview-${simpleHash(fileId)}`,
    [fileId],
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let canceled = false;
    const face = new FontFace(family, `url(${JSON.stringify(objectUrl)})`);
    void face
      .load()
      .then((loaded) => {
        if (!canceled) document.fonts.add(loaded);
      })
      .catch(() => {
        if (!canceled) setFailed(true);
      });
    return () => {
      canceled = true;
      document.fonts.delete(face);
    };
  }, [family, objectUrl]);

  if (failed) {
    return (
      <p className="px-6 py-16 text-center text-sm text-muted-foreground">
        This browser cannot render {name}, but the original font can still be
        downloaded.
      </p>
    );
  }

  return (
    <div
      className="space-y-8 px-6 py-10 sm:px-10"
      style={{ fontFamily: family }}
    >
      <p className="break-words text-5xl leading-tight sm:text-7xl">
        Aa Bb Cc Dd Ee
      </p>
      <p className="break-words text-3xl leading-relaxed">
        The quick brown fox jumps over the lazy dog.
      </p>
      <p className="break-words text-2xl leading-relaxed">
        ABCDEFGHIJKLMNOPQRSTUVWXYZ
        <br />
        abcdefghijklmnopqrstuvwxyz
        <br />
        0123456789 !?&amp;@#$%
      </p>
    </div>
  );
}

function RepositoryBinaryPreview({ hex }: { hex: string }) {
  return (
    <div>
      <p className="border-b bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        No specialized renderer is available for this binary format. Showing the
        first 32 KB as hexadecimal and ASCII.
      </p>
      <pre className="overflow-auto p-4 font-mono text-xs leading-5">
        {hex || "This file is empty."}
      </pre>
    </div>
  );
}

function simpleHash(value: string): string {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  }
  return Math.abs(hash).toString(36);
}
