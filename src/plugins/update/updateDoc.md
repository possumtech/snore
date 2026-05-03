## <update status="N">{brief status}</update> - Report turn status
<!-- Header defines position, frequency, and status code requirement. -->
YOU MUST conclude every turn with one (and only one) <update></update>.
YOU MUST refer to your current mode instructions for valid values of N.
<!-- Single source of truth for codes is the current phase instructions block, not this doc. Listing codes here leaks termination knowledge (e.g. 200) that strong models use to short-circuit the protocol. -->
YOU MUST keep <update status="N"></update> body to <= 80 characters.
<!-- Length cap. -->
