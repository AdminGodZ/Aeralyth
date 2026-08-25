export type FolderZipSource =
  | {
      directory?: false;
      file: File;
      path: string;
    }
  | {
      directory: true;
      lastModified: number;
      path: string;
    };

export type FolderZipCompressionMode = "balanced" | "speed";

export type FolderZipWorkerRequest =
  | {
      type: "compress";
      sources: FolderZipSource[];
      compressionMode?: FolderZipCompressionMode;
      maxOutputBytes?: number;
    }
  | {
      type: "cancel";
    };

export type FolderZipWorkerResponse =
  | {
      type: "progress";
      processedBytes: number;
      totalBytes: number;
      currentPath: string;
    }
  | {
      type: "complete";
      archive: Blob;
    }
  | {
      type: "canceled";
    }
  | {
      type: "error";
      message: string;
    };
