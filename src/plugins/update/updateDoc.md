## <update status="N">{brief status}</update> - Status report (exactly one per turn, at the end)
<!-- Header defines position, frequency, and status code requirement. -->

REQUIRED: the valid values of N are defined by your current stage instructions.
<!-- Single source of truth for codes is the current phase instructions block, not this doc. Listing codes here leaks termination knowledge (e.g. 200) that strong models use to short-circuit the protocol. -->

REQUIRED: YOU MUST keep <update></update> body to <= 80 characters.
<!-- Length cap. -->
