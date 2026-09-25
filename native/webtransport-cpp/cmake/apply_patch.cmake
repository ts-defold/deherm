if(NOT DEFINED DEHERM_GIT OR NOT DEFINED DEHERM_PATCH)
  message(FATAL_ERROR "DEHERM_GIT and DEHERM_PATCH are required")
endif()

execute_process(
  COMMAND "${DEHERM_GIT}" apply --check "${DEHERM_PATCH}"
  RESULT_VARIABLE apply_check
  OUTPUT_VARIABLE apply_check_stdout
  ERROR_VARIABLE apply_check_stderr)

if(apply_check EQUAL 0)
  execute_process(
    COMMAND "${DEHERM_GIT}" apply "${DEHERM_PATCH}"
    RESULT_VARIABLE apply_result
    OUTPUT_VARIABLE apply_stdout
    ERROR_VARIABLE apply_stderr)
  if(NOT apply_result EQUAL 0)
    message(FATAL_ERROR "Patch passed validation but could not be applied: ${DEHERM_PATCH}\n${apply_stdout}\n${apply_stderr}")
  endif()
  return()
endif()

# FetchContent can replay PATCH_COMMAND when an existing build directory is
# reconfigured. An exact reverse-check proves that the declared patch is
# already present; any other source state still fails closed.
execute_process(
  COMMAND "${DEHERM_GIT}" apply --reverse --check "${DEHERM_PATCH}"
  RESULT_VARIABLE reverse_check
  OUTPUT_VARIABLE reverse_stdout
  ERROR_VARIABLE reverse_stderr)
if(reverse_check EQUAL 0)
  message(STATUS "Patch already applied: ${DEHERM_PATCH}")
  return()
endif()

message(FATAL_ERROR
  "Patch is neither applicable nor already applied: ${DEHERM_PATCH}\n"
  "apply --check:\n${apply_check_stdout}\n${apply_check_stderr}\n"
  "apply --reverse --check:\n${reverse_stdout}\n${reverse_stderr}")
