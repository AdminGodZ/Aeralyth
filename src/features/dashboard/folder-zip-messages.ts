export type FolderZipSource = {
  file: File;
  path: string;
};

export type FolderZipWorkerRequest =
  | {
      type: "compress";
      sources: FolderZipSource[];
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
