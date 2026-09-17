import { S3Client } from "@aws-sdk/client-s3";
import { config } from "../config/config";

export const s3 = new S3Client({
  region: config.REGION,
  credentials: {
    accessKeyId: config.ACCESS_KEY,
    secretAccessKey: config.SECRET_KEY,
  },
});