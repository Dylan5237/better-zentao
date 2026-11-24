import { z } from "zod";
import { requiredFieldsDto } from "../core/dto/metadata.ts";
import type { RequiredFieldsMap } from "../core/dto/metadata.ts";
import {
  currentUserDto,
  departmentNodeDto,
  instanceConfigDto,
  userDto,
} from "../core/dto/org.ts";
import type {
  CurrentUser,
  DepartmentNode,
  InstanceConfig,
  User,
} from "../core/dto/org.ts";
import type { ZentaoReadClient } from "./client.ts";
import { paginate } from "./internal/paginate.ts";
import { getReadClient } from "./internal/read-client.ts";
import { pageSchema } from "./internal/read-page.ts";

const userPage = pageSchema("users", userDto, true);

export async function getInstanceConfig(
  client: ZentaoReadClient,
): Promise<InstanceConfig> {
  return getReadClient(client).http.read(
    {
      pathTemplate: "/index.php",
      query: { mode: "getconfig" },
      schemaFields: Object.keys(instanceConfigDto.in.shape),
    },
    instanceConfigDto,
  );
}

export async function getCurrentUser(
  client: ZentaoReadClient,
): Promise<CurrentUser> {
  return getReadClient(client).http.read(
    {
      pathTemplate: "/api.php/v1/user",
      schemaFields: Object.keys(currentUserDto.in.shape),
    },
    currentUserDto,
  );
}

export async function getRequiredFields(
  client: ZentaoReadClient,
): Promise<RequiredFieldsMap> {
  return getReadClient(client).http.read(
    {
      pathTemplate: "/api.php/v1/requiredFields",
      schemaFields: Object.keys(requiredFieldsDto.in.shape),
    },
    requiredFieldsDto,
  );
}

export async function getDepartments(
  client: ZentaoReadClient,
): Promise<DepartmentNode[]> {
  return getReadClient(client).http.read(
    {
      pathTemplate: "/api.php/v1/departments",
      schemaFields: ["id", "name", "parent", "items"],
    },
    z.array(departmentNodeDto),
  );
}

export async function listUsers(
  client: ZentaoReadClient,
): Promise<{ items: User[]; truncated: boolean }> {
  return paginate(
    getReadClient(client).http,
    {
      pathTemplate: "/api.php/v2/users",
      schemaFields: ["users", "total", "pager"],
    },
    {
      mode: "v2",
      pageSize: 3000,
      schema: userPage,
    },
  );
}

export async function listUsersByDepartment(
  client: ZentaoReadClient,
  departmentId: number,
): Promise<{ items: User[]; truncated: boolean }> {
  return paginate(
    getReadClient(client).http,
    {
      pathTemplate: "/api.php/v2/company/browse",
      objectId: departmentId,
      query: { param: departmentId, type: "bydept" },
      schemaFields: ["users", "total", "pager"],
    },
    {
      mode: "v2",
      pageSize: 200,
      schema: userPage,
    },
  );
}
