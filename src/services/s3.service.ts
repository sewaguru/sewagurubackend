import {
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3 } from "./s3.client";
import { config } from "../config/config";
import crypto from "crypto";

interface UploadResult {
  key: string;
  url: string;
}

export const uploadToS3 = async (
  file: Express.Multer.File,
  folder: string = "uploads"
): Promise<UploadResult> => {
  const fileExtension = file.originalname.split(".").pop();
  const key = `${folder}/${crypto.randomUUID()}.${fileExtension}`;

  const command = new PutObjectCommand({
    Bucket: config.BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  });

  await s3.send(command);

  return {
    key,
    url: `https://${config.BUCKET}.s3.${config.REGION}.amazonaws.com/${key}`,
  };
};

export const deleteFromS3 = async (key: string): Promise<void> => {
  const command = new DeleteObjectCommand({
    Bucket: config.BUCKET,
    Key: key,
  });

  await s3.send(command);
};

export const getSignedFileUrl = async (
  key: string,
  expiresIn: number = 3600
): Promise<string> => {
  const command = new GetObjectCommand({
    Bucket: config.BUCKET,
    Key: key,
  });

  return await getSignedUrl(s3, command, { expiresIn });
};

export const extractKeyFromUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url)
    return parsed.pathname.substring(1) // remove leading "/"
  } catch {
    return null
  }
}
