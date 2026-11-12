import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';
import { MISSED_RUN_POLICIES, MissedRunPolicy } from '../scheduler/cron-schedule';

const isPresent = (_dto: object, value: unknown) => value !== undefined;

export class CreateWorkflowDto {
  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'name must not be blank' })
  name: string;

  @IsArray()
  @ArrayNotEmpty()
  steps: unknown[];

  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsString()
  cron?: string | null;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(MISSED_RUN_POLICIES)
  missedRunPolicy?: MissedRunPolicy;
}

export class UpdateWorkflowDto {
  @ValidateIf(isPresent)
  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'name must not be blank' })
  name?: string;

  @ValidateIf(isPresent)
  @IsArray()
  @ArrayNotEmpty()
  steps?: unknown[];

  @IsOptional()
  @ValidateIf((_dto, value) => value !== null)
  @IsString()
  cron?: string | null;

  @ValidateIf(isPresent)
  @IsString()
  timezone?: string;

  @ValidateIf(isPresent)
  @IsBoolean()
  enabled?: boolean;

  @ValidateIf(isPresent)
  @IsIn(MISSED_RUN_POLICIES)
  missedRunPolicy?: MissedRunPolicy;
}
