import { FIXTURE_TEXT } from "./fixture-text.ts";

function words(text: string): Set<string> {
  return new Set(text.trim().split(/\s+/u));
}

export const accountFields = words(
  "account accounts username usernames loginname actor actors assignee assignees assignedto openedby opener finishedby closedby canceledby cancelledby createdby reviewedby reviewby reviewedlist reviewer reviewers resolvedby activatedby editedby lasteditedby changedby updatedby deletedby approvedby acceptedby verifiedby feedbackbyaccount feedbackbyaccounts maintainer receiver manager owner mailto whitelist po qd rd pm",
);

export const nameFields = words(
  "realname realnames displayname fullname chinesename actorname assignedtoname openedbyname",
);

export const freeTextFields = words(
  "title subtitle name spec desc description verify comment comments sourcenote message error text content reason why detail summary note notes remark remarks feedbackby feedbackbytext steps repro expected actual code projectname productname modulename moduletitle planname executionname deptname departmentname storytitle label labels subject keywords pinyin nickname signature",
);

// Unrecognized object keys may themselves be account IDs or business labels.
const structuralFields = words(`
  endpoint body response profile user userinfo users departments department depttree todos
  data item items rows records list payload result error errors message status code detail
  metadata meta nested children root parent path paths object objecttype objectid action
  id ids active disabled deleted isparent required optional total totalcount page pageid
  pager pagecount rectotal pagetotal recperpage limit offset count hasmore browsetype mode module moduleid
  modulename moduletitle modules moduleoptionmenu modulepairs config option options optionmenu menu fields field
  fieldname requiredfields create edit delete read finish batchcreate change close version maxversion urandsr edition
  requesttype sessionname requestfix modulevar methodvar viewvar
  lang locale timezone env admin administrator isadmin alias order sort orderby grade
  accountid accountids departmentid dept deptid deptids role roles groups group groupid groupids
  members memberslist team teams working teamid teammembers company companyid userlist
  product productid productids products branch branchid branches line lineid view
  project projectid projects model execution executionid executionids executions executioncount program programid
  plan planid planids plans productplan productplans childrenplans planstories linkedplans
  story stories storyid storyids storytype storycount requirement requirements requirementid
  epic epics epicid linkedstories linkedrequirements linkstories linkrequirements
  tostory fromstory linkstory unlinks unlinkstories
  task tasks taskid taskids maintask subtask subtasks childrentasks
  bug bugs bugid bugids release releases releaseid build builds buildid openedbuild resolvedbuild confirmed
  versiontag versions actions histories history timeline revisions record records row
  objecttitle title name value values kind type status stage source category extra
  sourcelist categorylist prilist stagelist statuslist forcereview needreview neednotreview
  eststarted begin end estend deadline due estimate consumed left hours effort currentconsumed
  capacity totalleft totalestimate totalconsumed todocount progress delay days daysleft duration backlog board column
  realstarted starteddate finished finishedtime finisheddate closeddate opendate openeddate
  assigneddate lastediteddate firstediteddate canceleddate activateddate resolveddate changeddate revieweddate
  createddate createtime date updateddate editeddate lastdate lastchecked lastlogin loginat
  createdat updatedat openedat updatedtime time times timestamp
  prio pri priority level severity resolution resolvedreason closedreason cancelreason frequency
  storypoints mailto notify notifications counts assigntodept
  dateformat dateformatfull lastcheckedtime dynamic relation relations target targetid from fromid
  to toid relationtype groupby keys key label format beginmonth endmonth
  file files fileid filename extension filetype filesize size path url uri href src
  link links homepage website apiurl attachment attachments attachmentid downloadurl
  timeout request query method fields contenttype
  oftype system top subteam userdept division intake intakeid resultcount
  requiredfield stagerequirements
`);

const enumeratedFields = {
  action:
    "opened edited assigned finished closed activated resolved canceled cancelled reviewed commented changed created started paused resumed deleted linked unlinked",
  category:
    "feature design interface requirement epic story config code install performance security standard reliability automation maintainability",
  closedreason:
    "done cancel cancelled canceled duplicate postponed bydesign willnotfix notbug external converted",
  deleted: "true false yes no y n",
  isparent: "true false yes no y n",
  mode: "linear multi single task story bug requirement epic",
  model: "scrum waterfall waterfallplus kanban",
  result: "success fail failure error ok",
  role: "pm po rd qd dev qa pd td ur ui test manager admin engineer designer developer tester product research others super",
  source:
    "customer user po market service operation support tech business other competitor developer tester partner self product team dev forum ai bug",
  stage:
    "wait planned projected design designing review reviewed handoff dev developing developed interface test testing tested acceptance verified verification delivery delivered delivering released closed",
  status:
    "draft reviewing reviewed active changing changed closed wait doing pause done cancel canceled cancelled suspended opened resolved testing tested planned normal disabled available unavailable unclosed all blocked ready failed pending",
  type: "story requirement epic task bug feature design interface devel dev test affair document debug automation manual sprint waterfall kanban project program execution product normal noplan withplan branch host user department release plan",
  edition: "oss open source opensource open-source biz max professional",
  format: "json html xml",
  method: "get",
  requesttype: "get post",
  browsetype: "assignedto reviewby openedby finishedby reviewedby bydept",
};

const fieldEnums = new Map(
  Object.entries(enumeratedFields).map(([key, values]) => [key, words(values)]),
);

const enumMapFields = new Map([
  ["source", "source"],
  ["sourcelist", "source"],
  ["category", "category"],
  ["categorylist", "category"],
  ["stagelist", "stage"],
  ["statuslist", "status"],
  ["prilist", "pri"],
]);
const enumMapRoleKeys = words("po pm rd qd");
const formEnumFields = words("source category pri stage status");
const fixtureDate =
  /^\d{4}-\d{2}-\d{2}(?:([ Tt])\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:?\d{2})?)?$/u;
const formEntities = words(
  "story requirement epic task bug product project execution release",
);
const formActions = words("create edit finish batchcreate change close");

const endpoints = words(`
  api.php v1 v2 user requiredFields departments users company browse my work contribute
  products plans productplan view stories product story requirement projects executions
  tasks bugs releases create
`);
const queryMatchers = [
  /^(?:recPerPage|pageID|limit|page|param|productID|planID|storyID)=(?:\d+|\{id\})$/u,
  /^(?:fields=moduleOptionMenu|storyType=requirement|type=bydept)$/u,
  /^(?:status=(?:unclosed|all|undone|delayed|wait|doing)|mode=(?:task|story|bug|requirement|epic))$/u,
  /^browseType=(?:assignedTo|reviewBy|openedBy|finishedBy|reviewedBy)$/u,
];
// Stable slugs used by the offline file convention, independent of the raw service hostname.
const endpointSlugs = words(`
  instance-config current-user required-fields departments users company-browse users-by-department
  my-work my-contribute products product-modules product-module-menu modules module-option-menu
  product-plans plans plan-detail product-plan-detail stories story-list story-detail story-detail-v2
  story-view story-view-v2 requirement-list requirements requirement-detail requirement-view
  projects executions executions-v1 executions-v2 active-executions all-executions execution-tasks
  tasks task-detail product-bugs project-bugs product-releases releases story-create story-create-meta
  product-stories product-requirements story-create-metadata
`);

export const isIdString = (value: string): boolean => /^-?\d+$/u.test(value);

export function fixtureKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z\d]/gu, "");
}

export interface FixtureFieldContext {
  readonly key: string;
  readonly field: string;
  readonly parentField: string;
  readonly inRequiredFields: boolean;
}

export const rootFixtureContext: FixtureFieldContext = {
  key: "",
  field: "",
  parentField: "",
  inRequiredFields: false,
};

export function fixtureChildContext(
  parent: FixtureFieldContext,
  key: string,
): FixtureFieldContext {
  const field = fixtureKey(key);
  return {
    key,
    field,
    parentField: parent.field,
    inRequiredFields:
      parent.inRequiredFields || isFixtureFormDefinition(parent.field, field),
  };
}

export function fixtureArrayItemContext(
  context: FixtureFieldContext,
  item: unknown,
): FixtureFieldContext {
  // A record inside an array is not the direct role object.
  if (
    context.field === "role" &&
    item !== null &&
    typeof item === "object" &&
    !Array.isArray(item)
  ) {
    return { ...context, field: "" };
  }
  return context;
}

export function isSchemaFixtureKey(key: string): boolean {
  if (!/^[a-z][a-z\d_-]*$/iu.test(key)) return false;
  const canonical = fixtureKey(key);
  return (
    structuralFields.has(canonical) ||
    accountFields.has(canonical) ||
    nameFields.has(canonical) ||
    freeTextFields.has(canonical) ||
    fieldEnums.has(canonical)
  );
}

export function isFixtureEndpoint(value: string): boolean {
  if (
    value === "/index.php?mode=getconfig" ||
    value === "GET /index.php?mode=getconfig"
  )
    return true;
  if (endpointSlugs.has(value)) return true;
  const [path, query, extra] = value.replace(/^GET /u, "").split("?");
  return (
    extra === undefined &&
    path !== undefined &&
    /^\/api\.php\/v[12]\//u.test(path) &&
    path
      .slice(1)
      .split("/")
      .every(
        (part) => endpoints.has(part) || part === "{id}" || isIdString(part),
      ) &&
    (query === undefined ||
      query
        .split("&")
        .every((part) => queryMatchers.some((matcher) => matcher.test(part))))
  );
}

export function isFixtureEnum(field: string, value: string): boolean {
  if (field === "sessionname") {
    return value === "zentaosid" || value === "PHPSESSID";
  }
  return fieldEnums.get(field)?.has(value.toLowerCase()) === true;
}

export function isFixtureRoleCode(
  context: FixtureFieldContext,
  value: string,
): boolean {
  return (
    context.field === "code" &&
    context.parentField === "role" &&
    isFixtureEnum("role", value)
  );
}

export type FixtureOptionMap =
  | { readonly kind: "account" }
  | { readonly kind: "enum"; readonly field: string; readonly nested: boolean };

export function fixtureOptionMap(
  { field, parentField }: FixtureFieldContext,
  entries: readonly (readonly [string, unknown])[],
): FixtureOptionMap | undefined {
  const nested = field === "options";
  if (nested && accountFields.has(parentField)) {
    return { kind: "account" };
  }
  // A form definition under fields may consist entirely of string properties.
  const enumField = nested
    ? formEnumFields.has(parentField)
      ? parentField
      : undefined
    : parentField === "fields"
      ? undefined
      : enumMapFields.get(field);
  if (
    enumField !== undefined &&
    entries.every(([, label]) => typeof label === "string")
  ) {
    return { kind: "enum", field: enumField, nested };
  }
}

export function isFixtureEnumMapKey(
  map: Extract<FixtureOptionMap, { kind: "enum" }>,
  key: string,
): boolean {
  return (
    (!map.nested && enumMapRoleKeys.has(key.toLowerCase())) ||
    isFixtureEnum(map.field, key) ||
    (map.field === "pri" && /^[1-4]$/u.test(key))
  );
}

export function isFixtureFormDefinition(
  field: string,
  childKey: string,
): boolean {
  return (
    field === "requiredfields" ||
    (formEntities.has(field) && formActions.has(childKey))
  );
}

export function isFixtureRequiredFieldList(value: string): boolean {
  return value
    .split(/[,\s]+/u)
    .every((key) => key === "" || isSchemaFixtureKey(key));
}

export function isFixtureModuleMenu(field: string): boolean {
  return field === "moduleoptionmenu" || field === "modulepairs";
}

export function isFixtureModulePath(value: string): boolean {
  return (
    value === "/" ||
    (value.startsWith("/") &&
      value
        .slice(1)
        .split("/")
        .every((segment) => segment === FIXTURE_TEXT))
  );
}

export function maskUnknownFixtureDate(value: string): string | undefined {
  const parts = fixtureDate.exec(value);
  if (parts === null) return;
  if (value.startsWith("0000-00-00")) return value;
  const [, separator, fraction, zone] = parts;
  if (separator === undefined) return "2000-01-01";
  return (
    "2000-01-01" +
    separator +
    "00:00:00" +
    (fraction?.replace(/\d/gu, "0") ?? "") +
    (zone?.replace(/\d/gu, "0") ?? "")
  );
}

export function preserveFixtureString(
  field: string,
  value: string,
  inRequiredFields: boolean,
): boolean {
  if (field === "endpoint") return isFixtureEndpoint(value);
  if (field === "sessionname") return isFixtureEnum(field, value);
  if (isFixtureEnum(field, value)) return true;
  if (inRequiredFields && isFixtureRequiredFieldList(value)) {
    return true;
  }
  return (
    /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(value) ||
    fixtureDate.test(value) ||
    (/^(?:plan|path|ids|planids|storyids|executionids|productids)$/u.test(
      field,
    ) &&
      /^,?\d+(?:,\d+)*,?$/u.test(value)) ||
    ((field === "version" || field === "versiontag") &&
      /^v?\d+\.\d+(?:\.\d+)?(?:-?(?:alpha|beta|rc)\.?\d*|\+\d+)?$/iu.test(
        value,
      )) ||
    (field === "keywords" && /^版本[:：]v\d+\.\d+(?:\.\d+)?$/iu.test(value))
  );
}

export function isUrlFixtureString(field: string, text: string): boolean {
  return (
    /(?:url|uri)$/u.test(field) ||
    /^(?:href|link|file|filepath|src|homepage|website|path)$/u.test(field) ||
    /^(?:https?|ftps?|file):\/\/|^\/\//iu.test(text)
  );
}
