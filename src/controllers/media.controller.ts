import { Request, Response } from "express";
import { prisma } from "../lib/prisma";

import {
  uploadToS3,
  deleteFromS3,
} from "../services/s3.service";

import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";

//////////////////////////////////////////////////////
// SAFE ID
//////////////////////////////////////////////////////
const getId = (
  value: unknown,
  field = "id"
): string => {
  if (!value || typeof value !== "string") {
    throw new AppError(`Invalid ${field}`, 400);
  }
  return value;
};

//////////////////////////////////////////////////////
// RECURSIVE CHILD FINDER ✅
//////////////////////////////////////////////////////
const getAllFolderIds = async (
  folderId: string
): Promise<string[]> => {

  const children =
    await prisma.mediaFolder.findMany({
      where: { parentId: folderId },
      select: { id: true },
    });

  let ids = [folderId];

  for (const child of children) {
    const nested =
      await getAllFolderIds(child.id);

    ids.push(...nested);
  }

  return ids;
};

//////////////////////////////////////////////////////
// CREATE FOLDER
//////////////////////////////////////////////////////
export const createFolder = catchAsync(
  async (req: Request, res: Response) => {

    const { name, parentId } = req.body;

    if (!name)
      throw new AppError("Folder name required",400);

    const slug = name
      .toLowerCase()
      .trim()
      .replace(/\s+/g,"-");

    const folder =
      await prisma.mediaFolder.create({
        data:{
          name,
          slug,
          parentId: parentId || null,
        },
      });

    res.json(successResponse(folder,"Folder created"));
  }
);

//////////////////////////////////////////////////////
// GET FOLDERS
//////////////////////////////////////////////////////
export const getFolders = catchAsync(
  async (req: Request,res: Response)=>{

    const parentId =
      req.query.parentId as string;

    const folders =
      await prisma.mediaFolder.findMany({
        where:{
          parentId: parentId || null,
        },
        include:{
          _count:{
            select:{
              media:true,
              children:true,
            },
          },
        },
        orderBy:{createdAt:"asc"},
      });

    res.json(successResponse(folders));
  }
);

//////////////////////////////////////////////////////
// UPDATE FOLDER
//////////////////////////////////////////////////////
export const updateFolder = catchAsync(
async (req:Request,res:Response)=>{

  const id=getId(req.params.id);

  const {name}=req.body;

  const slug=name
    .toLowerCase()
    .trim()
    .replace(/\s+/g,"-");

  const folder=
    await prisma.mediaFolder.update({
      where:{id},
      data:{name,slug},
    });

  res.json(successResponse(folder,"Updated"));
});

//////////////////////////////////////////////////////
// DELETE FOLDER ✅ TRUE RECURSIVE DELETE
//////////////////////////////////////////////////////
export const deleteFolder = catchAsync(
async(req:Request,res:Response)=>{

  const id=getId(req.params.id);

  //////////////////////////////////////////////////
  // GET ALL RELATED FOLDERS
  //////////////////////////////////////////////////
  const folderIds =
    await getAllFolderIds(id);

  //////////////////////////////////////////////////
  // GET MEDIA
  //////////////////////////////////////////////////
  const media =
    await prisma.media.findMany({
      where:{
        folderId:{in:folderIds},
      },
    });

  //////////////////////////////////////////////////
  // DELETE S3 FILES
  //////////////////////////////////////////////////
  await Promise.all(
    media.map(m =>
      deleteFromS3(m.key)
    )
  );

  //////////////////////////////////////////////////
  // DELETE MEDIA
  //////////////////////////////////////////////////
  await prisma.media.deleteMany({
    where:{
      folderId:{in:folderIds},
    },
  });

  //////////////////////////////////////////////////
  // DELETE FOLDERS
  //////////////////////////////////////////////////
  await prisma.mediaFolder.deleteMany({
    where:{
      id:{in:folderIds},
    },
  });

  res.json(
    successResponse(
      null,
      "Folder deleted"
    )
  );
});

//////////////////////////////////////////////////////
// UPLOAD MEDIA
//////////////////////////////////////////////////////
export const uploadMedia = catchAsync(
async(req:Request,res:Response)=>{

  if(!req.file)
    throw new AppError("No file",400);

  const {folderId}=req.body;

  let folder=null;

  if(folderId){
    folder=
      await prisma.mediaFolder.findUnique({
        where:{id:folderId},
      });

    if(!folder)
      throw new AppError("Folder not found",404);
  }

  const result=
    await uploadToS3(
      req.file,
      folder?.slug || "general"
    );

  const media=
    await prisma.media.create({
      data:{
        url:result.url,
        key:result.key,
        fileName:req.file.originalname,
        mimeType:req.file.mimetype,
        size:req.file.size,
        folderId:folder?.id || null,
      },
    });

  res.json(successResponse(media,"Uploaded"));
});

//////////////////////////////////////////////////////
// GET MEDIA
//////////////////////////////////////////////////////
export const getMediaByFolder =
catchAsync(async(req,res)=>{

  const id=getId(req.params.id);

  const media=
    await prisma.media.findMany({
      where:{folderId:id},
      orderBy:{createdAt:"desc"},
    });

  res.json(successResponse(media));
});

//////////////////////////////////////////////////////
// MOVE MEDIA
//////////////////////////////////////////////////////
export const moveMedia =
catchAsync(async(req,res)=>{

  const {mediaId,folderId}=req.body;

  if(!mediaId)
    throw new AppError("mediaId required",400);

  await prisma.media.update({
    where:{id:mediaId},
    data:{folderId:folderId||null},
  });

  res.json(successResponse(null,"Moved"));
});

//////////////////////////////////////////////////////
// DELETE MEDIA ✅
//////////////////////////////////////////////////////
export const deleteMedia =
catchAsync(async(req,res)=>{

  const id=getId(req.params.id);

  const media=
    await prisma.media.findUnique({
      where:{id},
    });

  if(!media)
    throw new AppError("Not found",404);

  await deleteFromS3(media.key);

  await prisma.media.delete({
    where:{id},
  });

  res.json(successResponse(null,"Deleted"));
});


//////////////////////////////////////////////////////
// RENAME MEDIA
//////////////////////////////////////////////////////
export const renameMedia = catchAsync(
  async (req: Request, res: Response) => {
    const id = getId(req.params.id);
    const { fileName } = req.body as { fileName?: string };

    if (!fileName || typeof fileName !== "string") {
      throw new AppError("fileName is required", 400);
    }

    const media = await prisma.media.update({
      where: { id },
      data: { fileName },
    });

    res.json(successResponse(media, "Renamed"));
  }
);

//////////////////////////////////////////////////////
// GET SINGLE FOLDER ✅
//////////////////////////////////////////////////////
export const getFolderById = catchAsync(
  async (req: Request, res: Response) => {

    const id = getId(req.params.id);

    const folder =
      await prisma.mediaFolder.findUnique({
        where: { id },
        include: {
          _count: {
            select: {
              media: true,
              children: true,
            },
          },
        },
      });

    if (!folder)
      throw new AppError("Folder not found", 404);

    res.json(successResponse(folder));
  }
);