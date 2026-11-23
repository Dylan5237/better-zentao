import { fixtureKey } from "./fixture-sensitivity.ts";

function words(text: string): Set<string> {
  return new Set(text.trim().split(/\s+/u));
}

export const accountFields = words(
  "account accounts username usernames loginname actor actors assignee assignees assignedto openedby opener finishedby closedby canceledby cancelledby createdby reviewedby reviewby reviewedlist reviewers resolvedby activatedby editedby lasteditedby updatedby deletedby approvedby acceptedby verifiedby feedbackbyaccount feedbackbyaccounts maintainer receiver manager owner mailto whitelist po qd rd pm",
);

export const nameFields = words(
  "realname realnames displayname fullname chinesename actorname assignedtoname openedbyname",
);

export const freeTextFields = words(
  "title subtitle name spec desc description verify comment comments sourcenote message error text content reason why detail summary note notes remark remarks feedbackby feedbackbytext steps repro expected actual code projectname productname modulename moduletitle planname executionname deptname departmentname label labels subject keywords pinyin nickname signature",
);

// Unrecognized object keys may themselves be account IDs or business labels.
const structuralFields = words(`
  endpoint body response profile user userinfo users departments department depttree todos
  data item items rows records list payload result error errors message status code detail
  metadata meta nested children root parent path paths object objecttype objectid action
  id ids active disabled deleted isparent required optional total totalcount page pageid
  pager pagecount recperpage limit offset count hasmore browsetype mode module moduleid
  modulename moduletitle modules moduleoptionmenu config option options optionmenu menu fields field
  fieldname requiredfields create edit delete read version maxversion urandsr edition
  lang locale timezone env admin administrator isadmin alias order sort orderby
  accountid accountids departmentid dept deptid deptids role roles groups group groupid groupids
  members memberslist team teams working teamid company companyid userlist
  product productid productids products branch branchid branches line lineid view
  project projectid projects execution executionid executionids executions program programid
  plan planid planids plans productplan productplans childrenplans planstories linkedplans
  story stories storyid storyids storytype requirement requirements requirementid
  epic epics epicid linkedstories linkedrequirements linkstories linkrequirements
  tostory fromstory linkstory unlinks unlinkstories
  task tasks taskid taskids maintask subtask subtasks childrentasks
  bug bugs bugid bugids release releases releaseid build builds buildid
  versiontag versions actions histories history timeline revisions record records row
  objecttitle title name value values kind type status stage source category
  eststarted begin end estend deadline due estimate consumed left hours effort
  capacity totalleft progress delay days daysleft duration backlog board column
  realstarted starteddate finished finishedtime finisheddate closeddate opendate openeddate
  assigneddate lastediteddate firstediteddate canceleddate activateddate resolveddate
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
  result: "success fail failure error ok",
  role: "pm po rd qd dev qa pd td ur ui test manager admin engineer designer developer tester product research others super",
  source:
    "customer user po market service operation support tech business other competitor developer tester partner self product team",
  stage:
    "wait planned projected design designing review reviewed handoff dev developing developed interface test testing tested acceptance verified verification delivery delivered delivering released closed",
  status:
    "draft reviewing reviewed active changing changed closed wait doing pause done cancel canceled cancelled suspended opened resolved testing tested planned normal disabled available unavailable unclosed all blocked ready failed pending",
  type: "story requirement epic task bug feature design interface devel dev test affair document debug automation manual sprint waterfall kanban project program execution product normal noplan withplan branch host user department release plan",
  edition: "oss open source opensource open-source biz max professional",
  format: "json html xml",
  method: "get",
  browsetype: "assignedto reviewby openedby finishedby reviewedby bydept",
};

const fieldEnums = new Map(
  Object.entries(enumeratedFields).map(([key, values]) => [key, words(values)]),
);

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

function isFixtureEndpoint(value: string): boolean {
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
  return fieldEnums.get(field)?.has(value.toLowerCase()) === true;
}

export function preserveFixtureString(
  field: string,
  value: string,
  inRequiredFields: boolean,
): boolean {
  if (field === "endpoint") return isFixtureEndpoint(value);
  if (isFixtureEnum(field, value)) return true;
  if (
    inRequiredFields &&
    value.split(/[,\s]+/u).every((key) => key === "" || isSchemaFixtureKey(key))
  ) {
    return true;
  }
  return (
    /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(value) ||
    /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/u.test(
      value,
    ) ||
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
