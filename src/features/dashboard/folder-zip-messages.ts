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
      /**
       * Upper bound of the helper workers that compress in parallel. Defaults
       * to the number of logical processors.
       */
      maxWorkers?: number;
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
