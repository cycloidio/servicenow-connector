function onChange(control, oldValue, newValue, isLoading) {
	// The environment list depends on the selected project
	if (isLoading || newValue === oldValue) {
		return;
	}
	g_form.clearValue('cycloid_environment');
}
