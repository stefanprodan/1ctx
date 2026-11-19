import { SandboxClient } from "openshell-sdk";
import { SandboxSchema } from "openshell-sdk/raw";
import { createGrpcTransport } from "@connectrpc/connect-node";
export const c = [SandboxClient, SandboxSchema, createGrpcTransport];
