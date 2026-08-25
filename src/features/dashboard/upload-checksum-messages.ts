export type UploadChecksumWorkerRequest =
  | {
      type: "hash";
      id: number;
      blob: Blob;
    }
  | {
      type: "cancel";
      id: number;
    };

export type UploadChecksumWorkerResponse =
  | {
      type: "complete";
      id: number;
      checksumSha256: string;
    }
  | {
      type: "error";
      id: number;
      message: string;
    };
